const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { protect } = require('../middleware/authMiddleware');

// Send message (requires authentication)
router.post('/send', protect, messageController.sendMessage);

// Send template message (requires authentication)
router.post('/send-template', protect, messageController.sendTemplate);

// Delete message
router.delete('/:messageId', protect, messageController.deleteMessage);

// Forward message
router.post('/:messageId/forward', protect, messageController.forwardMessage);

// Add reaction
router.post('/:messageId/reaction', protect, messageController.addReaction);

// Search messages
router.get('/search', protect, messageController.searchMessages);

// Get paginated messages
router.get('/paginated', protect, messageController.getMessagesPaginated);

module.exports = router;

