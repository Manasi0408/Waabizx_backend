const { getProjectId } = require('../utils/projectScope');
const { getWhatsAppPaymentState } = require('../utils/whatsappPayment');

/**
 * Blocks API access when Meta WhatsApp is linked but tokens are incomplete.
 */
async function requireWhatsAppPaymentActive(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const projectId = getProjectId(req);
    const state = await getWhatsAppPaymentState(userId, projectId);
    if (state.hasWhatsAppAccount && state.paymentRequired) {
      return res.status(403).json({
        success: false,
        message: 'Complete WhatsApp connection first.',
        redirectUrl: '/connect-whatsapp',
      });
    }
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Could not verify WhatsApp billing status',
      error: error.message,
    });
  }
}

module.exports = { requireWhatsAppPaymentActive };
