const logger = require('./logger');

function maskBearer(value) {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) {
    if (raw.length <= 12) return raw ? '***' : '';
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  const token = raw.slice(7).trim();
  if (token.length <= 16) return 'Bearer ***';
  return `Bearer ${token.slice(0, 8)}...${token.slice(-6)}`;
}

function sanitizeDirectApiPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.headers && typeof copy.headers === 'object') {
    const h = { ...copy.headers };
    if (h.Authorization) h.Authorization = maskBearer(h.Authorization);
    if (h.authorization) h.authorization = maskBearer(h.authorization);
    if (h['X-AiSensy-Partner-API-Key']) h['X-AiSensy-Partner-API-Key'] = '***';
    if (h['x-aisensy-partner-api-key']) h['x-aisensy-partner-api-key'] = '***';
    copy.headers = h;
  }
  if (copy.authorization) copy.authorization = maskBearer(copy.authorization);
  if (copy.password) copy.password = '***';
  if (copy.direct_api_password_enc) copy.direct_api_password_enc = '***';
  if (copy.direct_api_jwt) {
    const t = String(copy.direct_api_jwt);
    copy.direct_api_jwt = t.length > 20 ? `${t.slice(0, 12)}...${t.slice(-8)}` : '***';
  }
  if (copy.body?.password) copy.body.password = '***';
  if (copy.raw) copy.raw = '***';
  return copy;
}

function sanitizeRequest(request) {
  if (!request || typeof request !== 'object') return request;
  const copy = JSON.parse(JSON.stringify(request));
  if (copy.headers) {
    const h = { ...copy.headers };
    if (h.Authorization) h.Authorization = maskBearer(h.Authorization);
    if (h.authorization) h.authorization = maskBearer(h.authorization);
    copy.headers = h;
  }
  return copy;
}

/**
 * Log Direct API call: REQUEST, PAYLOAD, RESPONSE → direct-api.log + console
 */
function logDirectApi(operation, request, payload, response) {
  if (arguments.length === 3 && response === undefined) {
    logger.directApiPayloadResponse(operation, null, sanitizeDirectApiPayload(request), sanitizeDirectApiPayload(payload));
    return;
  }
  if (arguments.length === 2) {
    logger.directApiPayloadResponse(operation, null, null, sanitizeDirectApiPayload(request));
    return;
  }
  logger.directApiPayloadResponse(
    operation,
    sanitizeRequest(request),
    sanitizeDirectApiPayload(payload),
    sanitizeDirectApiPayload(response)
  );
}

/**
 * Outbound WhatsApp sends — REQUEST + PAYLOAD + RESPONSE
 * → backend/logs/whatsapp-send.log AND backend/logs/direct-api.log + console
 */
function logWhatsAppSend(operation, request, payload, response) {
  if (arguments.length === 3 && response === undefined) {
    logger.whatsappSendPayloadResponse(operation, null, sanitizeDirectApiPayload(request), sanitizeDirectApiPayload(payload));
    return;
  }
  if (arguments.length === 2) {
    logger.whatsappSendPayloadResponse(operation, null, null, sanitizeDirectApiPayload(request));
    return;
  }
  logger.whatsappSendPayloadResponse(
    operation,
    sanitizeRequest(request),
    sanitizeDirectApiPayload(payload),
    sanitizeDirectApiPayload(response)
  );
}

module.exports = {
  logDirectApi,
  logWhatsAppSend,
  maskBearer,
  sanitizeDirectApiPayload,
};
