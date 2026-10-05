function clampInt(raw, min, max, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getDbPoolMaxHint() {
  return Math.min(50, Math.max(5, parseInt(String(process.env.DB_POOL_MAX || '20'), 10) || 20));
}

/** Tunables for broadcast/campaign WhatsApp template pumps (env overrides). */
function getCampaignSendSettings() {
  const poolMax = getDbPoolMaxHint();
  const reservedForApi = 4;
  const sendConcurrencyCap = Math.max(3, poolMax - reservedForApi);
  let sendConcurrency = clampInt(process.env.CAMPAIGN_SEND_CONCURRENCY, 3, 80, 10);
  sendConcurrency = Math.min(sendConcurrency, sendConcurrencyCap);

  return {
    batchSize: clampInt(process.env.CAMPAIGN_BATCH_SIZE, 10, 250, 100),
    sendConcurrency,
    maxResumeCampaigns: clampInt(process.env.CAMPAIGN_MAX_RESUME, 1, 50, 1),
    maxConcurrentPumps: clampInt(process.env.CAMPAIGN_MAX_CONCURRENT_PUMPS, 1, 5, 1),
    pumpWatchdogMs: clampInt(process.env.CAMPAIGN_PUMP_WATCHDOG_MS, 15_000, 300_000, 30_000),
    rateLimitMaxRetries: clampInt(process.env.CAMPAIGN_SEND_RATE_LIMIT_RETRIES, 1, 8, 4),
    /** Pause between batches so /projects/list and other APIs get CPU + DB time during broadcasts. */
    batchPauseMs: clampInt(process.env.CAMPAIGN_BATCH_PAUSE_MS, 0, 2000, 250),
  };
}

module.exports = {
  getCampaignSendSettings,
};
