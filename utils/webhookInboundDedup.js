/**
 * Prevent duplicate flow/auto-reply handling when Meta + AiSensy webhook
 * payloads arrive for the same inbound WhatsApp message (or Meta retries).
 */
const recentInbound = new Map();
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

function pruneExpired() {
  const now = Date.now();
  for (const [key, ts] of recentInbound.entries()) {
    if (now - ts > TTL_MS) recentInbound.delete(key);
  }
  if (recentInbound.size > MAX_ENTRIES) {
    const sorted = [...recentInbound.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = recentInbound.size - MAX_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) {
      recentInbound.delete(sorted[i][0]);
    }
  }
}

/**
 * @returns {boolean} true if this inbound message should be processed now
 */
function claimInboundWebhookMessage(messageId, phone, text) {
  const id = String(messageId || '').trim();
  const key = id || `${String(phone || '').trim()}:${String(text || '').trim()}:${Math.floor(Date.now() / 2000)}`;
  if (!key) return true;

  pruneExpired();
  if (recentInbound.has(key)) {
    return false;
  }
  recentInbound.set(key, Date.now());
  return true;
}

module.exports = {
  claimInboundWebhookMessage,
};
