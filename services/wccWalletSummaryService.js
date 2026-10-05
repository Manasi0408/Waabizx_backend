function n(envKey, def) {
  const v = parseInt(process.env[envKey], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/** Rupees/credits charged per outbound WhatsApp unit (message or new 24h session). */
function getCreditUnitCost(opts = {}) {
  const perMsg = n('WCC_META_PER_MESSAGE_CREDITS', 0);
  if (perMsg > 0) return perMsg;
  if (opts.isTemplate) {
    const tmpl = n('WCC_META_TEMPLATE_SURCHARGE_CREDITS', 0);
    const conv = n('WCC_META_CONVERSATION_CREDITS', 1);
    return conv + tmpl;
  }
  return n('WCC_META_CONVERSATION_CREDITS', 1);
}

/** How many sends the current wallet balance can cover (conservative estimate). */
function estimateRemainingMessages(wccCredits, opts = {}) {
  const balance = Math.max(0, Number(wccCredits) || 0);
  const unit = getCreditUnitCost(opts);
  if (!unit || unit <= 0) return balance;
  return Math.floor(balance / unit);
}

module.exports = {
  getCreditUnitCost,
  estimateRemainingMessages,
};
