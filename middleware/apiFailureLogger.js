const logger = require('../utils/logger');

const SKIP_PATH_PREFIXES = [
  '/uploads/',
  '/favicon.ico',
  '/static/',
];

const API_PATH_PREFIXES = [
  '/api/',
  '/webhook',
  '/meta/',
  '/messages',
  '/partner',
  '/direct-apis',
  '/exchange-token',
  '/health',
];

function shouldLogApiFailure(req, statusCode) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!path) return false;
  if (SKIP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;

  const isApiPath = API_PATH_PREFIXES.some(
    (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix)
  );
  if (!isApiPath && statusCode === 404) return false;

  return statusCode >= 400;
}

function apiFailureLogger(req, res, next) {
  const startedAt = Date.now();

  res.on('finish', () => {
    const status = res.statusCode;
    if (!shouldLogApiFailure(req, status)) return;

    const path = String(req.originalUrl || req.url || '');
    logger.logApiFailure({
      direction: 'inbound',
      method: req.method,
      path,
      status,
      durationMs: Date.now() - startedAt,
      userId: req.user?.id ?? req.user?.userId ?? null,
      projectId:
        req.headers['x-project-id'] ||
        req.headers['x_project_id'] ||
        req.body?.projectId ||
        null,
      ip: req.ip,
      message: res.locals?.apiErrorMessage || `HTTP ${status}`,
      error: res.locals?.apiErrorStack
        ? { message: res.locals.apiErrorMessage, stack: res.locals.apiErrorStack }
        : null,
      request: {
        query: logger.sanitizeLogData(req.query || {}),
        body: logger.sanitizeLogData(req.body || {}),
        params: logger.sanitizeLogData(req.params || {}),
      },
      response: logger.sanitizeLogData(res.locals?.apiErrorBody || null),
    });
  });

  next();
}

module.exports = apiFailureLogger;
