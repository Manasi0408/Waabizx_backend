const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const chatbotController = require('../controllers/chatbotController');

// Send message to chatbot
router.post('/message', protect, chatbotController.sendMessage);

// Lock chatbot and route to inbox
router.post('/lock', protect, chatbotController.lockChatbot);

module.exports = router;

