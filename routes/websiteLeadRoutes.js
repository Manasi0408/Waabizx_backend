const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const {
  createDemoBooking,
  listDemoBookings,
  updateDemoBooking,
  createWebsiteLead,
  listWebsiteLeads,
  updateWebsiteLead,
  getDemoBookingFormOptions,
  getWebsiteLeadFormOptions,
} = require('../controllers/websiteLeadController');

// Public website forms (no auth)
router.get('/demo-bookings/form-options', getDemoBookingFormOptions);
router.get('/website-leads/form-options', getWebsiteLeadFormOptions);
router.post('/demo-bookings', createDemoBooking);
router.post('/website-leads', createWebsiteLead);

// Super Admin list / update
router.get('/demo-bookings', protect, authorize('super_admin'), listDemoBookings);
router.patch('/demo-bookings/:id', protect, authorize('super_admin'), updateDemoBooking);
router.get('/website-leads', protect, authorize('super_admin'), listWebsiteLeads);
router.patch('/website-leads/:id', protect, authorize('super_admin'), updateWebsiteLead);

module.exports = router;
