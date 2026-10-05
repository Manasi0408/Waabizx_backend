const express = require('express');
const router = express.Router();
const contactManagementController = require('../controllers/contactManagementController');
const { protect } = require('../middleware/authMiddleware');

// Update contact
router.put('/:contactId', protect, contactManagementController.updateContact);

// Get contact history
router.get('/:contactId/history', protect, contactManagementController.getContactHistory);

// Update typing status
router.post('/typing', protect, contactManagementController.updateTypingStatus);

// Update online status
router.post('/online', protect, contactManagementController.updateOnlineStatus);

module.exports = router;

