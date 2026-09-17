const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/metaWebhookController');
const { protect } = require('../middleware/authMiddleware');

// Webhook verification (GET) - for WhatsApp/Meta webhook verification
router.get('/', webhookController.verifyWebhook);

// Webhook endpoint (POST) - receives messages from webhook providers
router.post('/', webhookController.handleWebhook);

// Get webhook logs (for debugging) - requires authentication
router.get('/logs', protect, webhookController.getWebhookLogs);

module.exports = router;
