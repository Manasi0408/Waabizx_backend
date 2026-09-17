const AnalyticsModel = require('../models/analyticsModel');

// Helper function to get time range from query params
const getTimeRange = (req) => {
  const timeRange = req.query.timeRange || req.query.range || 'all'; // 'today', 'week', 'year', 'all'
  return timeRange;
};

exports.getOverview = async (req, res) => {
  try {
    const timeRange = getTimeRange(req);
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'User not authenticated' });
    const data = await AnalyticsModel.getOverview(timeRange, userId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCampaignAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    const timeRange = getTimeRange(req);
    const data = await AnalyticsModel.getCampaignAnalytics(timeRange, userId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getMessageAnalytics = async (req, res) => {
  try {
    const timeRange = getTimeRange(req);
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'User not authenticated' });
    const data = await AnalyticsModel.getMessageAnalytics(timeRange, userId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getContactAnalytics = async (req, res) => {
  try {
    const timeRange = getTimeRange(req);
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'User not authenticated' });
    const data = await AnalyticsModel.getContactAnalytics(timeRange, userId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCostAnalytics = async (req, res) => {
  try {
    const timeRange = getTimeRange(req);
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'User not authenticated' });
    const data = await AnalyticsModel.getCostAnalytics(timeRange, userId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
