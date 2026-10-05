/**
 * Normalize recipient for WhatsApp / Meta / AiSensy Direct API (digits only in output).
 *
 * Indian numbers — country code is optional:
 *   9876543210, 919876543210, +919876543210
 *
 * Non-Indian numbers — must include country code with a leading +:
 *   +15417543010 (US), +61412345678 (Australia)
 *
 * Numbers entered without + and without a country code are treated as Indian
 * and automatically get +91 (91 prefix in API format).
 */
function normalizeWhatsAppRecipient(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';

  const hasPlusPrefix = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  const defaultCountry = String(
    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ||
      process.env.DEFAULT_COUNTRY_CODE ||
      '91'
  ).replace(/\D/g, '') || '91';

  // Explicit international (+country code) — keep full digit string
  if (hasPlusPrefix) {
    digits = stripDuplicateCountryPrefix(digits, defaultCountry);
    return finalizeWhatsAppRecipientDigits(digits, defaultCountry);
  }

  // Indian number with country code but no + (e.g. 919876543210)
  if (
    defaultCountry &&
    digits.length === defaultCountry.length + 10 &&
    digits.startsWith(defaultCountry)
  ) {
    return finalizeWhatsAppRecipientDigits(stripDuplicateCountryPrefix(digits, defaultCountry), defaultCountry);
  }

  // 10-digit local number → prepend default country code (India +91)
  if (digits.length === 10 && defaultCountry) {
    return finalizeWhatsAppRecipientDigits(`${defaultCountry}${digits}`, defaultCountry);
  }

  // 0-prefixed local (e.g. 09876543210)
  if (digits.length === 11 && digits.startsWith('0') && defaultCountry) {
    return finalizeWhatsAppRecipientDigits(`${defaultCountry}${digits.slice(1)}`, defaultCountry);
  }

  digits = stripDuplicateCountryPrefix(digits, defaultCountry);
  return finalizeWhatsAppRecipientDigits(digits, defaultCountry);
}

function stripDuplicateCountryPrefix(digits, countryCode) {
  const cc = String(countryCode || '91').replace(/\D/g, '');
  if (!cc || !digits.startsWith(cc)) return digits;
  let out = digits;
  while (out.startsWith(`${cc}${cc}`)) {
    out = out.slice(cc.length);
  }
  return out;
}

function finalizeWhatsAppRecipientDigits(digits, defaultCountry) {
  const cc = String(defaultCountry || '91').replace(/\D/g, '') || '91';
  let out = stripDuplicateCountryPrefix(String(digits || '').replace(/\D/g, ''), cc);
  if (!out) return '';

  // Fix over-prefixed numbers like 9191876543210 → 919876543210
  if (cc === '91' && out.startsWith('91') && out.length > 12) {
    const national = out.slice(2);
    if (national.length === 10) {
      out = `91${national}`;
    } else if (national.startsWith('91') && national.length === 12) {
      out = national;
    } else if (national.length > 10) {
      out = `91${national.slice(-10)}`;
    }
  }

  // 10-digit local without country code slipped through
  if (out.length === 10 && cc) {
    out = `${cc}${out}`;
  }

  return out;
}

function hasRecipientPhone(phone) {
  return normalizeWhatsAppRecipient(phone).length >= 10;
}

/** Phone variants for DB lookup (campaign contacts, webhooks). */
function phoneVariantsForLookup(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return [];

  const digits = raw.replace(/\D/g, '');
  const normalized = normalizeWhatsAppRecipient(phone);
  const variants = new Set([raw, digits, normalized]);

  if (digits) {
    variants.add(`+${digits}`);
    if (normalized) {
      variants.add(`+${normalized}`);
    }
    if (digits.length >= 10) {
      variants.add(digits.slice(-10));
      variants.add(`91${digits.slice(-10)}`);
      variants.add(`+91${digits.slice(-10)}`);
    }
    if (normalized.length >= 10) {
      variants.add(normalized.slice(-10));
    }
  }

  return [...variants].filter(Boolean);
}

module.exports = {
  normalizeWhatsAppRecipient,
  hasRecipientPhone,
  phoneVariantsForLookup,
};
