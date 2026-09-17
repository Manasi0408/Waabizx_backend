const {
  getPublicConversationMetrics,
  getAdminConversationMetrics,
  updateConversationMetrics,
} = require('../services/conversationMetricsService');
const { resolvePricingContextFromRequest } = require('../utils/geoCountry');

exports.getPublicMetrics = async (req, res) => {
  try {
    const { country, currency } = await resolvePricingContextFromRequest(req);
    const payload = await getPublicConversationMetrics(currency);
    return res.json({
      success: true,
      country,
      currency: payload.currency || currency,
      metrics: payload.metrics,
      rates: payload.rates,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load conversation metrics',
      error: error.message,
    });
  }
};

exports.getAdminMetrics = async (req, res) => {
  try {
    const payload = await getAdminConversationMetrics();
    return res.json({
      success: true,
      metrics: payload.metrics,
      rates: payload.rates,
      config: payload.config,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load conversation metrics',
      error: error.message,
    });
  }
};

exports.updateAdminMetrics = async (req, res) => {
  try {
    const body = req.body || {};
    const hasUpdates = ['marketing', 'utility', 'authentication', 'service'].some(
      (key) => body[key] != null
    );
    if (!hasUpdates && body.metrics == null && body.rates == null) {
      return res.status(400).json({
        success: false,
        message: 'No conversation metric updates provided',
      });
    }

    const updates =
      body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics)
        ? body.metrics
        : body;

    const payload = await updateConversationMetrics(updates);
    return res.json({
      success: true,
      message: 'Conversation metrics updated',
      metrics: payload.metrics,
      rates: payload.rates,
      config: payload.config,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update conversation metrics',
      error: error.message,
    });
  }
};
