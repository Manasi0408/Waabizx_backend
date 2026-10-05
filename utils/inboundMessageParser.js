/**
 * Extract user-visible text from Meta WhatsApp inbound message payloads.
 *
 * Scenario 2 — Template quick-reply: type "button" with button.text / button.payload
 * Scenario 3 — Keyword: type "text" with text.body
 * Session interactive: type "interactive" with button_reply / list_reply
 *
 * NOT Meta WhatsApp Flows (nfm_reply) — those use a separate Flow endpoint on submit.
 */
function extractInboundReplyCandidates(messageObj) {
  const candidates = [];
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const exists = candidates.some((c) => c.toLowerCase() === s.toLowerCase());
    if (!exists) candidates.push(s);
  };

  if (!messageObj) return candidates;

  // Scenario 2: template quick-reply button tap
  add(messageObj.button?.text);
  add(messageObj.button?.payload);

  // Interactive session messages (quick reply / list)
  add(messageObj.interactive?.button_reply?.title);
  add(messageObj.interactive?.button_reply?.id);
  add(messageObj.interactive?.list_reply?.title);
  add(messageObj.interactive?.list_reply?.id);

  // Scenario 3: plain text keyword
  add(messageObj.text?.body);

  return candidates;
}

function extractInboundText(messageObj) {
  const candidates = extractInboundReplyCandidates(messageObj);
  if (candidates[0]) return candidates[0];

  const type = String(messageObj?.type || '').toLowerCase();
  if (type === 'image') {
    const cap = String(messageObj?.image?.caption || '').trim();
    return cap || '[Image]';
  }
  if (type === 'video') {
    const cap = String(messageObj?.video?.caption || '').trim();
    return cap || '[Video]';
  }
  if (type === 'audio') {
    return messageObj?.audio?.voice ? '[Voice message]' : '[Audio]';
  }
  if (type === 'document') {
    const cap = String(messageObj?.document?.caption || '').trim();
    const name = String(messageObj?.document?.filename || '').trim();
    return cap || name || '[Document]';
  }
  if (type === 'sticker') return '[Sticker]';
  if (type === 'location') return '[Location]';
  return '';
}

/** Short label for inbox sidebar / last message preview */
function extractInboundPreviewText(messageObj) {
  return extractInboundText(messageObj);
}

function getInboundMessageKind(messageObj) {
  const type = String(messageObj?.type || '').toLowerCase();
  if (type === 'button') return 'template_quick_reply';
  if (type === 'interactive') return 'interactive';
  if (type === 'text') return 'keyword';
  return type || 'unknown';
}

module.exports = {
  extractInboundText,
  extractInboundPreviewText,
  extractInboundReplyCandidates,
  getInboundMessageKind,
};
