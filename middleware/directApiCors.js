const { ProjectApiToken } = require('../models');
const { originsMatch, resolveRequestOrigin } = require('../services/apiTokenService');

function applyDirectApiCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, Origin, X-Requested-With'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

async function directApiCorsMiddleware(req, res, next) {
  try {
    const origin = resolveRequestOrigin(req);
    if (origin) {
      const activeTokens = await ProjectApiToken.findAll({
        where: { isActive: true },
        attributes: ['allowedDomain'],
      });
      const allowed = activeTokens.some((row) => originsMatch(origin, row.allowedDomain));
      if (allowed) applyDirectApiCorsHeaders(res, origin);
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  } catch (error) {
    console.error('Direct API CORS error:', error);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }
}

module.exports = {
  directApiCorsMiddleware,
  applyDirectApiCorsHeaders,
};
