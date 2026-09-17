const express = require('express');
const router = express.Router();
const {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaignAudience,
  getCampaignRetryPrefill,
  getCampaignReplies,
  addContactsToCampaign,
  estimateCampaignCost,
  calculateCampaignCost,
} = require('../controllers/campaignController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createCampaign);
router.post('/estimate-cost', protect, estimateCampaignCost);
router.post('/calculate-cost', protect, calculateCampaignCost);
router.get('/', protect, getCampaigns);
router.get('/:id', protect, getCampaignById);
router.put('/:id', protect, updateCampaign);
router.delete('/:id', protect, deleteCampaign);
router.post('/:id/contacts', protect, addContactsToCampaign);
router.post('/:id/start', protect, startCampaign);
router.post('/:id/pause', protect, pauseCampaign);
router.post('/:id/resume', protect, resumeCampaign);
router.get('/:id/audience', protect, getCampaignAudience);
router.get('/:id/replies', protect, getCampaignReplies);
router.get('/:id/retry-prefill', protect, getCampaignRetryPrefill);

module.exports = router;
