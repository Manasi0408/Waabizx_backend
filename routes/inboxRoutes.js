const express = require('express');
const router = express.Router();
const inboxController = require('../controllers/inboxController');
const { protect } = require('../middleware/authMiddleware');

// Get inbox chat list (one row per contact with last message and unread count)
router.get('/', protect, inboxController.getInboxList);

// Get messages of a specific contact by phone
router.get('/:phone/messages', protect, inboxController.getContactMessages);

// Contact profile: campaigns & payments (agent Chat Profile)
router.get('/:phone/campaigns', protect, inboxController.getContactCampaigns);
router.get('/:phone/payments', protect, inboxController.getContactPayments);

// Send message from inbox
router.post('/send', protect, inboxController.sendMessage);

// Mark messages as read for a contact
router.put('/:phone/read', protect, inboxController.markAsRead);

module.exports = router;

