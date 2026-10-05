const { Op } = require('sequelize');
const { Campaign, CampaignAudience } = require('../models');
const { getCampaignSendSettings } = require('./campaignSendSettings');

let pumpStarter = null;
let isPumpRunning = null;
let getActivePumpCount = null;

function registerCampaignPumpHandlers({ startPump, isRunning, activePumpCount }) {
  pumpStarter = typeof startPump === 'function' ? startPump : null;
  isPumpRunning = typeof isRunning === 'function' ? isRunning : null;
  getActivePumpCount = typeof activePumpCount === 'function' ? activePumpCount : null;
}

/**
 * Restart in-memory send pumps for campaigns left PROCESSING after deploy/restart.
 * Safe to call on a timer — skips campaigns that already have a live pump on this instance.
 */
async function ensureCampaignProcessingPumps() {
  if (!pumpStarter) return { resumed: 0, completed: 0 };

  const { maxResumeCampaigns, maxConcurrentPumps } = getCampaignSendSettings();
  const activePumps = getActivePumpCount ? getActivePumpCount() : 0;
  if (activePumps >= maxConcurrentPumps) {
    return { resumed: 0, completed: 0, skipped: 'pumps_active' };
  }

  const processing = await Campaign.findAll({
    where: { status: 'PROCESSING' },
    order: [['updatedAt', 'ASC']],
    limit: Math.max(maxResumeCampaigns, 3),
  });

  let resumed = 0;
  let completed = 0;
  let runningCount = 0;
  if (typeof isPumpRunning === 'function' && processing.length) {
    runningCount = processing.filter((row) => isPumpRunning(row.id)).length;
  }

  for (const row of processing) {
    if (resumed >= maxResumeCampaigns) {
      break;
    }

    const campaignId = row.id;
    if (isPumpRunning && isPumpRunning(campaignId)) {
      continue;
    }

    const pending = await CampaignAudience.count({
      where: { campaignId, status: 'pending' },
    });

    if (pending <= 0) {
      const [updated] = await Campaign.update(
        { status: 'COMPLETED', completedAt: new Date() },
        { where: { id: campaignId, status: 'PROCESSING' } }
      );
      if (updated) completed += 1;
      continue;
    }

    if (runningCount + resumed >= maxConcurrentPumps) {
      break;
    }

    console.log(
      `[campaign-pump] Resuming campaign ${campaignId} (${pending} pending recipient(s))`
    );
    pumpStarter(campaignId, row.userId, row.projectId);
    resumed += 1;
  }

  return { resumed, completed };
}

function getCampaignPumpWatchdogIntervalMs() {
  return getCampaignSendSettings().pumpWatchdogMs;
}

module.exports = {
  registerCampaignPumpHandlers,
  ensureCampaignProcessingPumps,
  getCampaignPumpWatchdogIntervalMs,
};
