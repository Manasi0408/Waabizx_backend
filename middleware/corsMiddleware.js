function normalizeOrigin(origin) {
  return String(origin || '')
    .trim()
    .replace(/\/$/, '')
    .toLowerCase();
}

const allowedOrigins = new Set(
  [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://app.waabizx.com',
    'https://waabizx.com',
    'https://www.waabizx.com',
    'https://api.waabizx.com',
    'https://wabizx.techwhizzc.com',
    'https://techwhizzc.com',
    'https://www.techwhizzc.com',
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    ...(String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)),
  ]
    .filter(Boolean)
    .map(normalizeOrigin)
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.has(normalized)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'waabizx.com' || host.endsWith('.waabizx.com')) return true;
    if (host === 'techwhizzc.com' || host.endsWith('.techwhizzc.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

function resolveCorsOrigin(origin) {
  if (!origin) return null;
  if (!isAllowedOrigin(origin)) return null;
  return String(origin).trim().replace(/\/$/, '');
}

function applyCorsHeaders(req, res) {
  const requestOrigin = String(req.headers.origin || '').trim();
  if (!requestOrigin) return null;

  const origin = resolveCorsOrigin(requestOrigin);
  if (!origin) return null;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    [
      'Content-Type',
      'Authorization',
      'x-project-id',
      'x_project_id',
      'Cache-Control',
      'Pragma',
      'Accept',
      'Origin',
      'X-Requested-With',
      'ngrok-skip-browser-warning',
    ].join(', ')
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  const vary = res.getHeader('Vary');
  if (!vary) res.setHeader('Vary', 'Origin');
  else if (!String(vary).includes('Origin')) res.setHeader('Vary', `${vary}, Origin`);
  return origin;
}

function corsMiddleware(req, res, next) {
  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

module.exports = {
  corsMiddleware,
  applyCorsHeaders,
  isAllowedOrigin,
  resolveCorsOrigin,
};
