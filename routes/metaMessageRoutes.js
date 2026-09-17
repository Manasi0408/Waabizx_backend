const express = require('express');
const router = express.Router();
const messageController = require('../controllers/metaMessageController');
const { protect } = require('../middleware/authMiddleware');

// Check WhatsApp API key connection
router.get('/check-api-key', messageController.checkApiKey);

// Get inbound messages (for external systems)
router.get('/inbound', protect, messageController.getInboundMessages);

// Get all meta messages (inbound + outbound) by phone
router.get('/all', protect, messageController.getAllMetaMessages);

// Get message status by ID
router.get('/status/:id', protect, messageController.getMessageStatus);

router.post('/send', protect, messageController.sendMessage);

module.exports = router;
