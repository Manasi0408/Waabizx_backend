const path = require('path');
const { fork } = require('child_process');

let workerChild = null;
let workerStarting = false;
let workerForkFailures = 0;
let dedicatedWorkerDisabled = false;

const MAX_FORK_FAILURES = 3;

function isWorkerProcess() {
  return String(process.env.CAMPAIGN_SEND_WORKER_PROCESS || '').trim() === '1';
}

function useDedicatedWorker() {
  if (dedicatedWorkerDisabled) return false;
  if (String(process.env.CAMPAIGN_SEND_INLINE || '').trim() === '1') return false;
  return String(process.env.CAMPAIGN_DEDICATED_WORKER || '').trim() === '1';
}

function runProcessCampaignOnApi(campaignId, userId, projectId) {
  const { processCampaignInternal } = require('../controllers/campaignController');
  processCampaignInternal(campaignId, userId, projectId).catch((err) => {
    console.error(`Error processing campaign ${campaignId}:`, err);
  });
}

function startInlineWatchdog() {
  const delayMs = Math.max(
    5000,
    parseInt(String(process.env.CAMPAIGN_PUMP_START_DELAY_MS || '20000'), 10) || 20000
  );

  setTimeout(() => {
    try {
      const {
        ensureCampaignProcessingPumps,
        getCampaignPumpWatchdogIntervalMs,
      } = require('../controllers/campaignController');

      ensureCampaignProcessingPumps().catch((e) =>
        console.warn('[campaign-pump] initial resume:', e?.message || e)
      );

      const intervalMs = Math.max(15_000, getCampaignPumpWatchdogIntervalMs() || 30_000);
      setInterval(() => {
        ensureCampaignProcessingPumps().catch((e) =>
          console.warn('[campaign-pump] watchdog tick:', e?.message || e)
        );
      }, intervalMs);
    } catch (e) {
      console.warn('[campaign-pump] watchdog init failed:', e?.message || e);
    }
  }, delayMs);
}

function forkCampaignWorker() {
  if (!useDedicatedWorker() || workerStarting || workerChild) return;
  if (workerForkFailures >= MAX_FORK_FAILURES) {
    dedicatedWorkerDisabled = true;
    console.warn('[campaign-worker] disabled after repeated fork failures — using API inline pump');
    startInlineWatchdog();
    return;
  }

  workerStarting = true;
  const workerPath = path.join(__dirname, 'campaignSendWorkerProcess.js');

  try {
    workerChild = fork(workerPath, [], {
      env: { ...process.env, CAMPAIGN_SEND_WORKER_PROCESS: '1' },
      stdio: 'inherit',
    });

    workerChild.on('exit', (code, signal) => {
      console.warn('[campaign-worker] exited', { code, signal });
      workerChild = null;
      workerStarting = false;
      workerForkFailures += 1;
      if (useDedicatedWorker() && workerForkFailures < MAX_FORK_FAILURES) {
        setTimeout(forkCampaignWorker, 30_000);
      } else {
        dedicatedWorkerDisabled = true;
        startInlineWatchdog();
      }
    });

    workerChild.on('error', (err) => {
      console.warn('[campaign-worker] fork error:', err?.message || err);
      workerChild = null;
      workerStarting = false;
      workerForkFailures += 1;
    });

    console.log('[campaign-worker] forked (opt-in dedicated worker)');
  } catch (e) {
    console.warn('[campaign-worker] could not fork:', e?.message || e);
    workerChild = null;
    workerForkFailures += 1;
    startInlineWatchdog();
  } finally {
    workerStarting = false;
  }
}

/** API server: inline pump by default; fork only when CAMPAIGN_DEDICATED_WORKER=1. */
function startCampaignSendWatchdog() {
  if (isWorkerProcess()) return;

  if (useDedicatedWorker()) {
    const delayMs = Math.max(
      10_000,
      parseInt(String(process.env.CAMPAIGN_WORKER_FORK_DELAY_MS || '45000'), 10) || 45_000
    );
    setTimeout(forkCampaignWorker, delayMs);
    return;
  }

  startInlineWatchdog();
}

function notifyCampaignWorkerWake() {
  if (workerChild && workerChild.connected) {
    try {
      workerChild.send({ type: 'wake' });
    } catch (_) {
      /* fall through */
    }
  }
}

function scheduleCampaignProcessing(campaignId, userId, projectId) {
  if (isWorkerProcess()) {
    runProcessCampaignOnApi(campaignId, userId, projectId);
    return;
  }

  if (useDedicatedWorker() && workerChild && workerChild.connected) {
    notifyCampaignWorkerWake();
    return;
  }

  runProcessCampaignOnApi(campaignId, userId, projectId);
}

module.exports = {
  startCampaignSendWatchdog,
  notifyCampaignWorkerWake,
  scheduleCampaignProcessing,
};
