const crypto = require('crypto');

function getConfiguredPartnerApiKey() {
  return String(
    process.env.AISENSY_PARTNER_API_KEY ||
      process.env.X_AISENSY_PARTNER_API_KEY ||
      process.env.PARTNER_API_KEY ||
      ''
  ).trim();
}

function getConfiguredPartnerId() {
  return String(process.env.AISENSY_PARTNER_ID || process.env.PARTNER_ID || '').trim();
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractPartnerApiKey(req) {
  const headerKey = String(
    req.headers['x-aisensy-partner-api-key'] ||
      req.headers['x_aisensy_partner_api_key'] ||
      ''
  ).trim();
  if (headerKey) return headerKey;

  const raw = String(req.headers.authorization || '').trim();
  if (raw.toLowerCase().startsWith('bearer ')) {
    return raw.slice(7).trim();
  }
  return '';
}

exports.requirePartnerApiKey = (req, res, next) => {
  const expectedKey = getConfiguredPartnerApiKey();
  if (!expectedKey) {
    return res.status(500).json({
      message: 'Partner API is not configured. Set AISENSY_PARTNER_API_KEY in backend/.env.',
    });
  }

  const token = extractPartnerApiKey(req);
  if (!token || !timingSafeEqual(token, expectedKey)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const configuredPartnerId = getConfiguredPartnerId();
  const routePartnerId = String(req.params.partnerId || '').trim();
  if (configuredPartnerId && routePartnerId && routePartnerId !== configuredPartnerId) {
    return res.status(403).json({ message: 'Invalid partner id' });
  }

  req.partnerId = routePartnerId || configuredPartnerId;
  return next();
};

exports.getConfiguredPartnerId = getConfiguredPartnerId;
