const logger = require('./logger');

function trimPayload(payload, maxLen = 12000) {
  try {
    const raw = JSON.stringify(payload ?? null);
    if (raw.length <= maxLen) return payload;
    return { truncated: true, preview: raw.slice(0, maxLen) + '…' };
  } catch (_) {
    return { note: 'unserializable payload' };
  }
}

/**
 * Log webhook events → backend/logs/webhook.log + console
 */
function logWebhook(operation, request, payload, response) {
  if (arguments.length === 3 && response === undefined) {
    logger.webhookPayloadResponse(operation, null, trimPayload(request), trimPayload(payload));
    return;
  }
  if (arguments.length === 2) {
    logger.webhookPayloadResponse(operation, null, null, trimPayload(request));
    return;
  }
  logger.webhookPayloadResponse(
    operation,
    request,
    trimPayload(payload),
    trimPayload(response)
  );
}

module.exports = {
  logWebhook,
};
