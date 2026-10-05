const { getCountryFromPhone } = require('../utils/phoneUtils');
const { detectCountryFromPhone } = require('./wccCountryPricingService');
const { normalizeCountryCode } = require('../utils/geoCountry');

const COUNTRY_LABELS = {
  IN: 'India',
  US: 'United States',
  BD: 'Bangladesh',
  GB: 'United Kingdom',
  AU: 'Australia',
  AE: 'United Arab Emirates',
  SG: 'Singapore',
  CA: 'Canada',
  DE: 'Germany',
  FR: 'France',
};

const COUNTRY_CURRENCY = {
  IN: 'INR',
  US: 'USD',
  BD: 'BDT',
  GB: 'GBP',
  AU: 'AUD',
  AE: 'AED',
  SG: 'SGD',
  CA: 'USD',
  DE: 'EUR',
  FR: 'EUR',
};

async function getCountryFromPhoneNumber(phone) {
  const fromLib = getCountryFromPhone(phone);
  if (fromLib) return normalizeCountryCode(fromLib);
  return normalizeCountryCode(detectCountryFromPhone(phone)) || null;
}

function getCountryLabel(isoCode) {
  const cc = normalizeCountryCode(isoCode);
  return COUNTRY_LABELS[cc] || cc || 'Unknown';
}

function getCountryCurrency(isoCode) {
  const cc = normalizeCountryCode(isoCode);
  return COUNTRY_CURRENCY[cc] || 'USD';
}

module.exports = {
  getCountryFromPhoneNumber,
  getCountryLabel,
  getCountryCurrency,
};
