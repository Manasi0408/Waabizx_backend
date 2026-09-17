const axios = require('axios');

function normalizeIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  const first = raw.split(',')[0].trim();
  if (first.startsWith('::ffff:')) return first.slice(7);
  return first;
}

function isLocalIp(ip) {
  return (
    !ip ||
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  const raw = forwarded || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return normalizeIp(String(raw).split(',')[0] || raw);
}

async function getCountryFromIp(ip) {
  const normalized = normalizeIp(ip);
  if (isLocalIp(normalized)) {
    return String(process.env.DEFAULT_DEV_COUNTRY || 'IN').trim().toUpperCase() || 'IN';
  }

  try {
    const response = await axios.get(`https://ipapi.co/${encodeURIComponent(normalized)}/json/`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    if (response.status >= 400) return 'US';
    const code = String(response.data?.country_code || '').trim().toUpperCase();
    return code || 'US';
  } catch {
    return 'US';
  }
}

function currencyFromCountry(country) {
  return String(country || '').toUpperCase() === 'IN' ? 'INR' : 'USD';
}

function normalizeCountryCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'IND' || raw === 'INDIA') return 'IN';
  if (raw === '+91' || raw === '91') return 'IN';
  return raw.length === 2 ? raw : raw;
}

function isIndianMobileNumber(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  // Self-service signup collects a 10-digit Indian mobile without country code.
  return /^\d{10}$/.test(digits);
}

function isIndianCountry(country) {
  return normalizeCountryCode(country) === 'IN';
}

function resolveIndianPricingFromRequest(req, hints = {}) {
  const bodyCountry = normalizeCountryCode(
    req?.body?.country || req?.body?.countryCode || req?.body?.country_code
  );
  if (isIndianCountry(bodyCountry)) {
    return { country: 'IN', currency: 'INR' };
  }

  const mobileHint =
    hints.mobileNumber ||
    req?.body?.mobileNumber ||
    req?.body?.mobile ||
    req?.body?.whatsappNumber;
  const explicitCountry = normalizeCountryCode(
    hints.country ||
      req?.body?.country ||
      req?.body?.countryCode ||
      req?.body?.country_code
  );
  if (isIndianMobileNumber(mobileHint) && (!explicitCountry || explicitCountry === 'IN')) {
    return { country: 'IN', currency: 'INR' };
  }

  const user = req?.user;
  if (user) {
    const userCountry = normalizeCountryCode(user.country);
    // Account country (e.g. US at registration) wins over 10-digit mobile shape
    if (userCountry && !isIndianCountry(userCountry)) {
      return null;
    }
    if (isIndianCountry(userCountry) || isIndianMobileNumber(user.mobileNumber || user.mobile_number)) {
      return { country: 'IN', currency: 'INR' };
    }
  }

  return null;
}

async function resolvePricingContextFromRequest(req, hints = {}) {
  // Explicit country from query / headers / body / hints wins first
  const explicitCountry = normalizeCountryCode(
    hints.country ||
      req?.query?.country ||
      req?.query?.countryCode ||
      req?.query?.country_code ||
      req?.headers?.['x-country-code'] ||
      req?.headers?.['cf-ipcountry'] ||
      req?.body?.country ||
      req?.body?.countryCode ||
      req?.body?.country_code
  );
  if (explicitCountry) {
    return {
      country: explicitCountry,
      currency: currencyFromCountry(explicitCountry),
    };
  }

  const indianPricing = resolveIndianPricingFromRequest(req, hints);
  if (indianPricing) {
    return indianPricing;
  }

  const user = req?.user;
  if (user?.country) {
    const userCountry = normalizeCountryCode(user.country);
    if (userCountry && !isIndianCountry(userCountry)) {
      return {
        country: userCountry,
        currency: currencyFromCountry(userCountry),
      };
    }
  }

  if (user?.currency) {
    const currency = String(user.currency).toUpperCase() === 'INR' ? 'INR' : 'USD';
    return {
      country: user.country || (currency === 'INR' ? 'IN' : 'US'),
      currency,
    };
  }

  const ip = getClientIp(req);
  const country = await getCountryFromIp(ip);
  return {
    country,
    currency: currencyFromCountry(country),
  };
}

module.exports = {
  getClientIp,
  getCountryFromIp,
  currencyFromCountry,
  normalizeCountryCode,
  isIndianMobileNumber,
  isIndianCountry,
  resolvePricingContextFromRequest,
};
