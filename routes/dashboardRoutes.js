const express = require('express');
const router = express.Router();
const { getDashboardStats, getAgentActivity, getConversationQuota } = require('../controllers/dashboardController');
const { protect } = require('../middleware/authMiddleware');

router.get('/stats', protect, getDashboardStats);
router.get('/agent-activity', protect, getAgentActivity);
router.get('/:accountId', protect, getConversationQuota);

module.exports = router;