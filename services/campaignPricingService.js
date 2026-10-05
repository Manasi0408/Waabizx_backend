const ExchangeRate = require('../models/ExchangeRate');
const { getMessageCost } = require('./whatsappPricingService');
const { normalizeBillingCategory } = require('./wccCountryPricingService');
const {
  getCountryFromPhoneNumber,
  getCountryLabel,
  getCountryCurrency,
} = require('./countryService');

function roundAmount(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

async function getExchangeRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || 'USD').trim().toUpperCase();
  const to = String(toCurrency || 'INR').trim().toUpperCase();
  if (from === to) return 1;

  const direct = await ExchangeRate.findOne({
    where: { base_currency: from, target_currency: to },
  });
  if (direct?.rate) return roundAmount(Number(direct.rate));

  const inverse = await ExchangeRate.findOne({
    where: { base_currency: to, target_currency: from },
  });
  if (inverse?.rate && Number(inverse.rate) > 0) {
    return roundAmount(1 / Number(inverse.rate));
  }

  const { fxRatesToInr, convertCurrency } = require('./wccCountryPricingService');
  const fx = fxRatesToInr();
  if (from === 'USD' && to === 'INR' && fx.USD) return roundAmount(fx.USD);
  return roundAmount(convertCurrency(1, from, to));
}

async function toUsdRate(amount, currency) {
  const value = roundAmount(amount);
  const cur = String(currency || 'USD').trim().toUpperCase();
  if (!value) return 0;
  if (cur === 'USD') return value;
  const usdToCur = await getExchangeRate('USD', cur);
  if (usdToCur > 0) return roundAmount(value / usdToCur);
  const { convertCurrency } = require('./wccCountryPricingService');
  const inUsd = convertCurrency(value, cur, 'USD');
  return roundAmount(inUsd);
}

/**
 * Country → category → rate (Super Admin DB) → FX → customer wallet currency.
 */
async function calculateMessageCost({
  phoneNumber,
  category,
  customerCurrency = 'INR',
}) {
  const phone = String(phoneNumber || '').trim();
  if (!phone) {
    throw new Error('Phone number is required');
  }

  const isoCode = await getCountryFromPhoneNumber(phone);
  if (!isoCode) {
    throw new Error(`Invalid or unsupported phone number: ${phone}`);
  }

  const billingCategory = normalizeBillingCategory(category);
  const walletCur = String(customerCurrency || 'INR').trim().toUpperCase();

  const priced = await getMessageCost({
    countryCode: isoCode,
    category: billingCategory,
    walletCurrency: walletCur,
  });

  const rateUsd = await toUsdRate(priced.originalPrice, priced.originalCurrency);
  const exchangeRate = await getExchangeRate('USD', walletCur);
  const rateLocal = roundAmount(priced.walletPrice);

  return {
    country: getCountryLabel(isoCode),
    countryCode: isoCode,
    currency: getCountryCurrency(isoCode),
    category: billingCategory,
    rateUsd,
    originalPrice: roundAmount(priced.originalPrice),
    originalCurrency: priced.originalCurrency,
    exchangeRate,
    exchangePair: `USD → ${walletCur}`,
    rateLocal,
  };
}

async function calculateCampaignPricingSummary({
  contacts = [],
  category,
  currency = 'INR',
}) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (!list.length) {
    throw new Error('Contacts are required');
  }
  if (!category) {
    throw new Error('Template category is required');
  }

  const walletCur = String(currency || 'INR').trim().toUpperCase();
  const countrySummary = {};

  for (const contact of list) {
    const phone =
      typeof contact === 'string'
        ? contact
        : contact?.phone || contact?.mobileNumber || contact?.mobile;
    if (!phone) continue;

    const result = await calculateMessageCost({
      phoneNumber: phone,
      category,
      customerCurrency: walletCur,
    });

    const key = result.countryCode;
    if (!countrySummary[key]) {
      countrySummary[key] = {
        country: result.country,
        countryCode: result.countryCode,
        currency: result.currency,
        category: result.category,
        messages: 0,
        rateUsd: result.rateUsd,
        originalPrice: result.originalPrice,
        originalCurrency: result.originalCurrency,
        exchangeRate: result.exchangeRate,
        exchangePair: result.exchangePair,
        rateLocal: result.rateLocal,
        totalLocal: 0,
      };
    }

    countrySummary[key].messages += 1;
    countrySummary[key].totalLocal = roundAmount(
      countrySummary[key].totalLocal + result.rateLocal,
      2
    );
  }

  const countries = Object.values(countrySummary);
  const totalAmount = roundAmount(
    countries.reduce((sum, item) => sum + Number(item.totalLocal || 0), 0),
    2
  );

  return {
    currency: walletCur,
    category: normalizeBillingCategory(category),
    countries,
    totalAmount,
    contactCount: countries.reduce((sum, row) => sum + Number(row.messages || 0), 0),
  };
}

module.exports = {
  calculateMessageCost,
  calculateCampaignPricingSummary,
  getExchangeRate,
  toUsdRate,
};
