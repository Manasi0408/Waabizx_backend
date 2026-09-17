const logger = require('./logger');

function maskPartnerKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 12) return '***';
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const h = { ...headers };
  if (h['X-AiSensy-Partner-API-Key']) {
    h['X-AiSensy-Partner-API-Key'] = maskPartnerKey(h['X-AiSensy-Partner-API-Key']);
  }
  if (h['x-aisensy-partner-api-key']) {
    h['x-aisensy-partner-api-key'] = maskPartnerKey(h['x-aisensy-partner-api-key']);
  }
  if (h.Authorization) h.Authorization = '***';
  if (h.authorization) h.authorization = '***';
  return h;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.password) copy.password = '***';
  if (copy.body?.password) copy.body.password = '***';
  if (copy.headers) copy.headers = sanitizeHeaders(copy.headers);
  return copy;
}

function sanitizeRequest(request) {
  if (!request || typeof request !== 'object') return request;
  const copy = JSON.parse(JSON.stringify(request));
  if (copy.headers) copy.headers = sanitizeHeaders(copy.headers);
  if (copy.body?.password) copy.body.password = '***';
  return copy;
}

/**
 * Log Partner API call with 3 lines: REQUEST, PAYLOAD, RESPONSE
 * @param {string} operation
 * @param {object|null} request - HTTP request meta (method, url, headers, partnerId)
 * @param {object|null} payload - request body (null for GET)
 * @param {object|null} response - API response or error
 */
function logPartnerApi(operation, request, payload, response) {
  if (arguments.length === 3 && response === undefined) {
    logger.partnerApiPayloadResponse(
      operation,
      null,
      sanitizePayload(request),
      sanitizePayload(payload)
    );
    return;
  }
  if (arguments.length === 2) {
    logger.partnerApiPayloadResponse(operation, null, null, sanitizePayload(request));
    return;
  }
  logger.partnerApiPayloadResponse(
    operation,
    sanitizeRequest(request),
    sanitizePayload(payload),
    sanitizePayload(response)
  );
}

module.exports = { logPartnerApi, sanitizePayload, sanitizeRequest };
