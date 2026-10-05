/**
 * Optional dedicated send process (enable with CAMPAIGN_DEDICATED_WORKER=1 on API).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bootDelayMs = Math.max(
  15_000,
  parseInt(String(process.env.CAMPAIGN_WORKER_BOOT_DELAY_MS || '60000'), 10) || 60_000
);

function startWorkerLoop() {
  const {
    ensureCampaignProcessingPumps,
    getCampaignPumpWatchdogIntervalMs,
  } = require('../controllers/campaignController');

  const tick = () => {
    ensureCampaignProcessingPumps().catch((e) => {
      console.warn('[campaign-worker] pump tick:', e?.message || e);
    });
  };

  console.log('[campaign-worker] started (isolated send process)');
  tick();

  const intervalMs = Math.max(15_000, getCampaignPumpWatchdogIntervalMs() || 30_000);
  setInterval(tick, intervalMs);

  process.on('message', (msg) => {
    if (msg && msg.type === 'wake') tick();
  });
}

console.log(`[campaign-worker] waiting ${bootDelayMs}ms for API/DB to finish boot…`);
setTimeout(startWorkerLoop, bootDelayMs);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
