const db = require('../config/db');
const { User } = require('../models');
const { getCachedMessageRates } = require('./conversationMetricsService');
const { normalizeCountryCode } = require('../utils/geoCountry');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');

let schemaReady = false;

const DEFAULT_WALLET_CURRENCY = 'INR';

/** Longest-prefix first (E.164 digits without +). */
const DIAL_PREFIX_TO_COUNTRY = [
  ['971', 'AE'],
  ['966', 'SA'],
  ['880', 'BD'],
  ['886', 'TW'],
  ['852', 'HK'],
  ['234', 'NG'],
  ['254', 'KE'],
  ['255', 'TZ'],
  ['256', 'UG'],
  ['351', 'PT'],
  ['353', 'IE'],
  ['358', 'FI'],
  ['420', 'CZ'],
  ['421', 'SK'],
  ['91', 'IN'],
  ['86', 'CN'],
  ['81', 'JP'],
  ['82', 'KR'],
  ['65', 'SG'],
  ['60', 'MY'],
  ['62', 'ID'],
  ['63', 'PH'],
  ['66', 'TH'],
  ['84', 'VN'],
  ['61', 'AU'],
  ['64', 'NZ'],
  ['55', 'BR'],
  ['52', 'MX'],
  ['49', 'DE'],
  ['48', 'PL'],
  ['47', 'NO'],
  ['46', 'SE'],
  ['45', 'DK'],
  ['44', 'GB'],
  ['41', 'CH'],
  ['39', 'IT'],
  ['34', 'ES'],
  ['33', 'FR'],
  ['32', 'BE'],
  ['31', 'NL'],
  ['27', 'ZA'],
  ['20', 'EG'],
  ['7', 'RU'],
  ['1', 'US'],
];

const COUNTRY_DEFAULT_CURRENCY = {
  IN: 'INR',
  US: 'USD',
  CA: 'USD',
  AU: 'AUD',
  GB: 'GBP',
  AE: 'AED',
  SA: 'SAR',
  SG: 'SGD',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  IE: 'EUR',
  PT: 'EUR',
  FI: 'EUR',
  JP: 'JPY',
  CN: 'CNY',
  HK: 'HKD',
  NZ: 'NZD',
  BR: 'BRL',
  MX: 'MXN',
  ZA: 'ZAR',
};

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeBillingCategory(raw) {
  const c = String(raw || 'marketing').trim().toLowerCase();
  if (['marketing', 'utility', 'authentication', 'service'].includes(c)) return c;
  if (c === 'promotional' || c === 'welcome') return 'marketing';
  if (c === 'transactional' || c === 'notification') return 'utility';
  if (c === 'auth') return 'authentication';
  return 'marketing';
}

function currencyForCountry(countryCode) {
  const cc = normalizeCountryCode(countryCode) || 'IN';
  return COUNTRY_DEFAULT_CURRENCY[cc] || 'USD';
}

function fxRatesToInr() {
  return {
    INR: 1,
    USD: Number(process.env.WCC_FX_USD_INR || 83),
    AUD: Number(process.env.WCC_FX_AUD_INR || 54),
    GBP: Number(process.env.WCC_FX_GBP_INR || 105),
    EUR: Number(process.env.WCC_FX_EUR_INR || 90),
    AED: Number(process.env.WCC_FX_AED_INR || 22.6),
    SAR: Number(process.env.WCC_FX_SAR_INR || 22.1),
    SGD: Number(process.env.WCC_FX_SGD_INR || 62),
    CAD: Number(process.env.WCC_FX_CAD_INR || 61),
    JPY: Number(process.env.WCC_FX_JPY_INR || 0.55),
    CNY: Number(process.env.WCC_FX_CNY_INR || 11.5),
    HKD: Number(process.env.WCC_FX_HKD_INR || 10.6),
    NZD: Number(process.env.WCC_FX_NZD_INR || 50),
    BRL: Number(process.env.WCC_FX_BRL_INR || 16),
    MXN: Number(process.env.WCC_FX_MXN_INR || 4.8),
    ZAR: Number(process.env.WCC_FX_ZAR_INR || 4.5),
  };
}

function convertCurrency(amount, fromCurrency, toCurrency) {
  const value = roundAmount(amount);
  const from = String(fromCurrency || DEFAULT_WALLET_CURRENCY).toUpperCase();
  const to = String(toCurrency || DEFAULT_WALLET_CURRENCY).toUpperCase();
  if (!value) return 0;
  if (from === to) return value;

  const fx = fxRatesToInr();
  const toInr = (amt, cur) => {
    if (cur === 'INR') return amt;
    const rate = fx[cur];
    if (!rate || rate <= 0) return amt;
    return roundAmount(amt * rate);
  };
  const fromInr = (amt, cur) => {
    if (cur === 'INR') return amt;
    const rate = fx[cur];
    if (!rate || rate <= 0) return amt;
    return roundAmount(amt / rate);
  };

  if (to === 'INR') return toInr(value, from);
  if (from === 'INR') return fromInr(value, to);
  return fromInr(toInr(value, from), to);
}

function detectCountryFromPhone(phone) {
  const normalized = normalizeWhatsAppRecipient(phone);
  const digits = String(normalized || phone || '').replace(/\D/g, '');
  if (!digits) return 'IN';

  if (digits.length === 10) {
    return 'IN';
  }

  for (const [prefix, country] of DIAL_PREFIX_TO_COUNTRY) {
    if (digits.startsWith(prefix)) {
      return country;
    }
  }

  return 'IN';
}

function resolveRecipientCountryCode({ phone, contact } = {}) {
  const fromContact =
    normalizeCountryCode(contact?.country_code) ||
    normalizeCountryCode(contact?.country) ||
    normalizeCountryCode(contact?.get?.('country_code')) ||
    normalizeCountryCode(contact?.get?.('country'));
  if (fromContact) return fromContact;
  return detectCountryFromPhone(phone);
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!Array.isArray(rows) || rows.length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function seedWhatsappPricing(conn) {
  let rates = {};
  try {
    rates = getCachedMessageRates() || {};
  } catch (_) {
    rates = {};
  }

  const india = {
    marketing: rates.marketing ?? 0.95,
    utility: rates.utility ?? 0.15,
    authentication: rates.authentication ?? 0.129,
    service: rates.service ?? 0,
  };

  const seeds = [
    { country: 'IN', currency: 'INR', rates: india },
    {
      country: 'US',
      currency: 'USD',
      rates: {
        marketing: 0.025,
        utility: 0.004,
        authentication: 0.004,
        service: 0,
      },
    },
    {
      country: 'AU',
      currency: 'AUD',
      rates: {
        marketing: 0.038,
        utility: 0.006,
        authentication: 0.006,
        service: 0,
      },
    },
    {
      country: 'GB',
      currency: 'GBP',
      rates: {
        marketing: 0.022,
        utility: 0.004,
        authentication: 0.004,
        service: 0,
      },
    },
    {
      country: 'AE',
      currency: 'AED',
      rates: {
        marketing: 0.09,
        utility: 0.015,
        authentication: 0.015,
        service: 0,
      },
    },
    {
      country: 'SG',
      currency: 'SGD',
      rates: {
        marketing: 0.035,
        utility: 0.006,
        authentication: 0.006,
        service: 0,
      },
    },
  ];

  for (const row of seeds) {
    for (const [category, rate] of Object.entries(row.rates)) {
      await conn.query(
        `INSERT INTO whatsapp_pricing (country_code, category, rate, currency, active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE rate = VALUES(rate), currency = VALUES(currency), active = 1`,
        [row.country, category, roundAmount(rate), row.currency]
      );
    }
  }
}

async function ensureWccCountryPricingSchema() {
  if (schemaReady) return;
  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country_code VARCHAR(5) NOT NULL,
        category VARCHAR(30) NOT NULL,
        rate DECIMAL(12,6) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'INR',
        active BOOLEAN DEFAULT TRUE,
        UNIQUE KEY unique_whatsapp_pricing (country_code, category)
      )
    `);

    await ensureColumn(conn, 'contacts', 'country_code', 'VARCHAR(5) NULL DEFAULT NULL');

    await seedWhatsappPricing(conn);
    schemaReady = true;
  } finally {
    conn.release();
  }
}

async function getWhatsappPricing(countryCode, category) {
  await ensureWccCountryPricingSchema();
  const cc = normalizeCountryCode(countryCode) || 'IN';
  const cat = normalizeBillingCategory(category);

  const [rows] = await db.query(
    `SELECT country_code, category, rate, currency
     FROM whatsapp_pricing
     WHERE country_code = ? AND category = ? AND active = 1
     LIMIT 1`,
    [cc, cat]
  );

  if (rows?.length) {
    return {
      countryCode: rows[0].country_code,
      category: rows[0].category,
      rate: roundAmount(rows[0].rate),
      currency: String(rows[0].currency || currencyForCountry(cc)).toUpperCase(),
    };
  }

  // Unknown countries use US rates (USD) configured in Super Admin.
  const [fallback] = await db.query(
    `SELECT country_code, category, rate, currency
     FROM whatsapp_pricing
     WHERE country_code = 'US' AND category = ? AND active = 1
     LIMIT 1`,
    [cat]
  );
  if (fallback?.length) {
    return {
      countryCode: cc,
      category: fallback[0].category,
      rate: roundAmount(fallback[0].rate),
      currency: String(fallback[0].currency || 'USD').toUpperCase(),
      fallbackFromUs: true,
    };
  }

  let rates = {};
  try {
    rates = getCachedMessageRates() || {};
  } catch (_) {
    rates = {};
  }
  return {
    countryCode: cc,
    category: cat,
    rate: roundAmount(rates[cat] ?? rates.marketing ?? 0.95),
    currency: 'INR',
    fallbackFromMetrics: true,
  };
}

async function getWalletCurrencyForOwner(ownerUserId) {
  const uid = Number(ownerUserId);
  if (!Number.isInteger(uid) || uid <= 0) return DEFAULT_WALLET_CURRENCY;
  try {
    const user = await User.findByPk(uid, { attributes: ['id', 'currency', 'country'] });
    const cur = String(user?.currency || '').trim().toUpperCase();
    if (cur) return cur === 'USD' ? 'USD' : cur === 'INR' ? 'INR' : cur;
    return currencyForCountry(user?.country) === 'USD' ? 'USD' : DEFAULT_WALLET_CURRENCY;
  } catch (_) {
    return DEFAULT_WALLET_CURRENCY;
  }
}

async function getMessageWccChargeInWalletCurrency({
  billingCategory,
  recipientPhone,
  contact = null,
  ownerUserId = null,
  walletCurrency = null,
} = {}) {
  const { getMessageCost } = require('./whatsappPricingService');
  await ensureWccCountryPricingSchema();

  const countryCode = resolveRecipientCountryCode({ phone: recipientPhone, contact });
  const walletCur = String(walletCurrency || (await getWalletCurrencyForOwner(ownerUserId)) || DEFAULT_WALLET_CURRENCY).toUpperCase();
  const priced = await getMessageCost({
    countryCode,
    category: billingCategory,
    walletCurrency: walletCur,
  });

  return {
    countryCode: priced.countryCode,
    billingCategory: normalizeBillingCategory(billingCategory),
    sourceRate: priced.originalPrice,
    sourceCurrency: priced.originalCurrency,
    walletCurrency: walletCur,
    charge: roundAmount(priced.walletPrice),
  };
}

async function maybePersistContactCountryCode(contactId, countryCode) {
  const cid = Number(contactId);
  const cc = normalizeCountryCode(countryCode);
  if (!Number.isInteger(cid) || cid <= 0 || !cc) return;
  try {
    await ensureWccCountryPricingSchema();
    await db.query(
      `UPDATE contacts
       SET country_code = COALESCE(NULLIF(country_code, ''), ?),
           country = COALESCE(NULLIF(country, ''), ?)
       WHERE id = ?`,
      [cc, cc, cid]
    );
  } catch (_) {
    /* non-fatal */
  }
}

async function calculateCampaignWccCostEstimate({
  phones = [],
  billingCategory = 'marketing',
  ownerUserId = null,
  walletCurrency = null,
}) {
  const { calculateCampaignCostByPhones } = require('./campaignCostService');
  const result = await calculateCampaignCostByPhones({
    phones,
    category: billingCategory,
    walletCurrency,
    ownerUserId,
  });
  return {
    totalCost: result.total,
    walletCurrency: result.currency,
    contactCount: result.contactCount,
    breakdown: result.breakdown,
  };
}

const ADMIN_PRICING_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'];

async function listAdminWhatsappPricing() {
  await ensureWccCountryPricingSchema();
  const { listExchangeRates } = require('./whatsappPricingService');
  const [rows] = await db.query(
    `SELECT country_code, category, rate, currency, active
     FROM whatsapp_pricing
     ORDER BY country_code ASC, category ASC`
  );

  const byCountry = {};
  for (const row of rows || []) {
    const cc = normalizeCountryCode(row.country_code) || 'IN';
    if (!byCountry[cc]) {
      byCountry[cc] = {
        countryCode: cc,
        currency: String(row.currency || currencyForCountry(cc)).toUpperCase(),
        rates: {},
      };
    }
    const cat = normalizeBillingCategory(row.category);
    byCountry[cc].rates[cat] = {
      rate: roundAmount(row.rate),
      currency: String(row.currency || byCountry[cc].currency).toUpperCase(),
      active: row.active === 1 || row.active === true,
    };
  }

  for (const country of Object.values(byCountry)) {
    for (const cat of ADMIN_PRICING_CATEGORIES) {
      if (!country.rates[cat]) {
        country.rates[cat] = {
          rate: 0,
          currency: country.currency,
          active: cat !== 'service',
        };
      }
    }
  }

  return {
    countries: Object.values(byCountry).sort((a, b) => a.countryCode.localeCompare(b.countryCode)),
    categories: ADMIN_PRICING_CATEGORIES,
    fxRates: fxRatesToInr(),
    exchangeRates: await listExchangeRates(),
  };
}

async function saveAdminWhatsappPricing(payload = {}) {
  const countries = Array.isArray(payload.countries) ? payload.countries : [];
  if (!countries.length) {
    throw new Error('No country pricing updates provided');
  }

  await ensureWccCountryPricingSchema();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const country of countries) {
      const cc = normalizeCountryCode(country.countryCode || country.country_code);
      if (!cc) continue;
      const currency = String(country.currency || currencyForCountry(cc)).toUpperCase();
      const rates = country.rates && typeof country.rates === 'object' ? country.rates : {};

      for (const category of ADMIN_PRICING_CATEGORIES) {
        const cfg = rates[category];
        if (cfg == null) continue;
        const rate = roundAmount(typeof cfg === 'number' ? cfg : cfg.rate);
        const active = typeof cfg === 'object' ? cfg.active !== false : true;
        await conn.query(
          `INSERT INTO whatsapp_pricing (country_code, category, rate, currency, active)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE rate = VALUES(rate), currency = VALUES(currency), active = VALUES(active)`,
          [cc, category, rate, currency, active ? 1 : 0]
        );
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return listAdminWhatsappPricing();
}

module.exports = {
  ensureWccCountryPricingSchema,
  detectCountryFromPhone,
  resolveRecipientCountryCode,
  getWhatsappPricing,
  currencyForCountry,
  fxRatesToInr,
  convertCurrency,
  getWalletCurrencyForOwner,
  getMessageWccChargeInWalletCurrency,
  maybePersistContactCountryCode,
  calculateCampaignWccCostEstimate,
  normalizeBillingCategory,
  listAdminWhatsappPricing,
  saveAdminWhatsappPricing,
};
