const { requireProjectId } = require('../utils/projectScope');
const { getProjectPlanLimitsSnapshot } = require('../services/planLimitService');

exports.getCurrentPlanLimits = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const snapshot = await getProjectPlanLimitsSnapshot(projectId);
    return res.json({
      success: true,
      ...snapshot,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load plan limits',
    });
  }
};
