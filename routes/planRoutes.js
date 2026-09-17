const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const {
  getActivePlans,
  getAllPlansAdmin,
  createPlan,
  updatePlan,
  deletePlan,
  getAdminPlanDiscounts,
  updateAdminPlanDiscounts,
} = require('../controllers/planController');
const {
  getPublicMetrics,
  getAdminMetrics,
  updateAdminMetrics,
} = require('../controllers/conversationMetricsController');
const {
  getAdminWhatsappPricing,
  updateAdminWhatsappPricing,
  getAdminExchangeRates,
  updateAdminExchangeRates,
  testWccPrice,
} = require('../controllers/whatsappPricingController');
const {
  getAdminWccSettings,
  updateAdminWccSettings,
} = require('../controllers/wccSettingsController');

// Public — marketing website (no auth)
router.get('/public/plans', getActivePlans);
router.get('/public/conversation-metrics', getPublicMetrics);

router.get('/plans', protect, getActivePlans);
router.get('/conversation-metrics', protect, getPublicMetrics);

router.get('/admin/plans', protect, authorize('super_admin'), getAllPlansAdmin);
router.get('/admin/plan-discounts', protect, authorize('super_admin'), getAdminPlanDiscounts);
router.put('/admin/plan-discounts', protect, authorize('super_admin'), updateAdminPlanDiscounts);
router.get('/admin/conversation-metrics', protect, authorize('super_admin'), getAdminMetrics);
router.put('/admin/conversation-metrics', protect, authorize('super_admin'), updateAdminMetrics);
router.get('/admin/whatsapp-pricing', protect, authorize('super_admin'), getAdminWhatsappPricing);
router.put('/admin/whatsapp-pricing', protect, authorize('super_admin'), updateAdminWhatsappPricing);
router.get('/admin/exchange-rates', protect, authorize('super_admin'), getAdminExchangeRates);
router.put('/admin/exchange-rates', protect, authorize('super_admin'), updateAdminExchangeRates);
router.get('/admin/wcc-settings', protect, authorize('super_admin'), getAdminWccSettings);
router.put('/admin/wcc-settings', protect, authorize('super_admin'), updateAdminWccSettings);
router.post('/wcc/test-price', protect, testWccPrice);
router.post('/admin/plans', protect, authorize('super_admin'), createPlan);
router.put('/admin/plans/:id', protect, authorize('super_admin'), updatePlan);
router.delete('/admin/plans/:id', protect, authorize('super_admin'), deletePlan);

module.exports = router;
