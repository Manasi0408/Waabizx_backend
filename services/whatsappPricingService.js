const db = require('../config/db');
const WhatsappPricing = require('../models/WhatsappPricing');
const ExchangeRate = require('../models/ExchangeRate');
const { getCachedMessageRates } = require('./conversationMetricsService');
const { normalizeCountryCode } = require('../utils/geoCountry');
const { detectCountryFromPhone, currencyForCountry, fxRatesToInr, normalizeBillingCategory } = require('./wccCountryPricingService');

let schemaReady = false;
const DEFAULT_WALLET_CURRENCY = 'INR';

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!Array.isArray(rows) || rows.length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function seedExchangeRates(conn) {
  const fx = fxRatesToInr();
  const pairs = Object.entries(fx).filter(([cur]) => cur !== 'INR');
  for (const [base, rate] of pairs) {
    if (!rate || rate <= 0) continue;
    await conn.query(
      `INSERT INTO exchange_rates (base_currency, target_currency, rate, updated_at)
       VALUES (?, 'INR', ?, NOW())
       ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()`,
      [base, rate]
    );
  }
}

async function ensureWhatsappPricingSchema() {
  if (schemaReady) return;
  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country_code VARCHAR(5) NOT NULL,
        category VARCHAR(30) NOT NULL,
        rate DECIMAL(18,8) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'INR',
        effective_from DATETIME NULL,
        effective_to DATETIME NULL,
        active TINYINT(1) DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_whatsapp_pricing (country_code, category),
        INDEX idx_country_category (country_code, category, active)
      )
    `);

    await ensureColumn(conn, 'whatsapp_pricing', 'effective_from', 'DATETIME NULL');
    await ensureColumn(conn, 'whatsapp_pricing', 'effective_to', 'DATETIME NULL');
    await ensureColumn(conn, 'whatsapp_pricing', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn(conn, 'whatsapp_pricing', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureColumn(conn, 'contacts', 'country_code', 'VARCHAR(5) NULL DEFAULT NULL');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS exchange_rates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        base_currency VARCHAR(10) NOT NULL,
        target_currency VARCHAR(10) NOT NULL,
        rate DECIMAL(18,10) NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY currency_pair (base_currency, target_currency)
      )
    `);

    await seedExchangeRates(conn);
    schemaReady = true;
  } finally {
    conn.release();
  }
}

function normalizePricingCategory(category) {
  return normalizeBillingCategory(category);
}

async function getWhatsAppRate(countryCode, category) {
  await ensureWhatsappPricingSchema();
  const cc = normalizeCountryCode(countryCode) || 'IN';
  const cat = normalizePricingCategory(category);

  const row = await WhatsappPricing.findOne({
    where: { country_code: cc, category: cat, active: true },
    order: [['effective_from', 'DESC']],
  });

  if (row) {
    return {
      countryCode: row.country_code,
      category: row.category,
      price: roundAmount(row.rate),
      currency: String(row.currency || currencyForCountry(cc)).toUpperCase(),
    };
  }

  const { getWhatsappPricing } = require('./wccCountryPricingService');
  const fallback = await getWhatsappPricing(cc, cat);
  return {
    countryCode: fallback.countryCode,
    category: fallback.category,
    price: roundAmount(fallback.rate),
    currency: String(fallback.currency || 'INR').toUpperCase(),
  };
}

async function convertToWalletCurrency(amount, fromCurrency, walletCurrency) {
  await ensureWhatsappPricingSchema();
  const value = roundAmount(amount);
  const from = String(fromCurrency || DEFAULT_WALLET_CURRENCY).toUpperCase();
  const to = String(walletCurrency || DEFAULT_WALLET_CURRENCY).toUpperCase();
  if (!value) return 0;
  if (from === to) return value;

  const direct = await ExchangeRate.findOne({
    where: { base_currency: from, target_currency: to },
  });
  if (direct?.rate) {
    return roundAmount(value * Number(direct.rate));
  }

  const inverse = await ExchangeRate.findOne({
    where: { base_currency: to, target_currency: from },
  });
  if (inverse?.rate && Number(inverse.rate) > 0) {
    return roundAmount(value / Number(inverse.rate));
  }

  const viaInrFrom = await ExchangeRate.findOne({
    where: { base_currency: from, target_currency: 'INR' },
  });
  const viaInrTo = await ExchangeRate.findOne({
    where: { base_currency: to, target_currency: 'INR' },
  });

  if (viaInrFrom?.rate) {
    const inr = roundAmount(value * Number(viaInrFrom.rate));
    if (to === 'INR') return inr;
    if (viaInrTo?.rate && Number(viaInrTo.rate) > 0) {
      return roundAmount(inr / Number(viaInrTo.rate));
    }
  }

  const { convertCurrency } = require('./wccCountryPricingService');
  return convertCurrency(value, from, to);
}

async function getMessageCost({ countryCode, category, walletCurrency }) {
  const pricing = await getWhatsAppRate(countryCode, category);
  const walletCur = String(walletCurrency || DEFAULT_WALLET_CURRENCY).toUpperCase();
  const walletPrice = await convertToWalletCurrency(pricing.price, pricing.currency, walletCur);

  return {
    countryCode: pricing.countryCode,
    category: pricing.category,
    originalPrice: pricing.price,
    originalCurrency: pricing.currency,
    walletPrice: roundAmount(walletPrice),
    walletCurrency: walletCur,
  };
}

async function listExchangeRates() {
  await ensureWhatsappPricingSchema();
  const rows = await ExchangeRate.findAll({ order: [['base_currency', 'ASC']] });
  return rows.map((row) => ({
    id: row.id,
    baseCurrency: row.base_currency,
    targetCurrency: row.target_currency,
    rate: Number(row.rate),
    updatedAt: row.updated_at,
  }));
}

async function saveExchangeRates(rates = []) {
  await ensureWhatsappPricingSchema();
  const list = Array.isArray(rates) ? rates : [];
  for (const item of list) {
    const base = String(item.baseCurrency || item.base_currency || '').trim().toUpperCase();
    const target = String(item.targetCurrency || item.target_currency || 'INR').trim().toUpperCase();
    const rate = Number(item.rate);
    if (!base || !target || !Number.isFinite(rate) || rate <= 0) continue;
    await ExchangeRate.upsert({
      base_currency: base,
      target_currency: target,
      rate,
      updated_at: new Date(),
    });
  }
  return listExchangeRates();
}

module.exports = {
  ensureWhatsappPricingSchema,
  getWhatsAppRate,
  convertToWalletCurrency,
  getMessageCost,
  listExchangeRates,
  saveExchangeRates,
};
