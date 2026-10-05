const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getChannels,
  getSettings,
  updateSettings,
  send,
  listConversations,
  listMessages,
  mockWebhook,
  buttonClick,
  getStats,
  seedDemoStats,
  seedInbox,
  listTemplates,
  createTemplate,
  listCampaigns,
  createCampaign,
  sendCampaign,
} = require('../controllers/rcsController');

router.get('/channels', protect, getChannels);

router.get('/settings', protect, getSettings);
router.put('/settings', protect, updateSettings);

router.post('/send', protect, send);
router.get('/conversations', protect, listConversations);
router.get('/messages', protect, listMessages);

router.post('/mock-webhook', protect, mockWebhook);
router.post('/button-click', protect, buttonClick);

router.get('/stats', protect, getStats);
router.post('/stats/seed', protect, seedDemoStats);
router.post('/inbox/seed', protect, seedInbox);

router.get('/templates', protect, listTemplates);
router.post('/templates', protect, createTemplate);

router.get('/campaigns', protect, listCampaigns);
router.post('/campaigns', protect, createCampaign);
router.post('/campaigns/:id/send', protect, sendCampaign);

module.exports = router;
