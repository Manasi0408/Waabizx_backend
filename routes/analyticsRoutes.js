const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect } = require('../middleware/authMiddleware');

router.get('/overview', protect, analyticsController.getOverview);
router.get('/campaigns', protect, analyticsController.getCampaignAnalytics);
router.get('/messages', protect, analyticsController.getMessageAnalytics);
router.get('/contacts', protect, analyticsController.getContactAnalytics);
router.get('/cost', protect, analyticsController.getCostAnalytics);

module.exports = router;
