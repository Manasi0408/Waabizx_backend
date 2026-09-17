const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { normalizeWhatsAppRecipient } = require('./phoneNormalize');
const { normalizeCountryCode } = require('./geoCountry');

function getCountryFromPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;

  try {
    const parsed = parsePhoneNumberFromString(raw.startsWith('+') ? raw : `+${normalizeWhatsAppRecipient(raw)}`);
    if (parsed?.country) {
      return normalizeCountryCode(parsed.country);
    }
  } catch (_) {
    /* fall through */
  }

  return null;
}

module.exports = {
  getCountryFromPhone,
};
