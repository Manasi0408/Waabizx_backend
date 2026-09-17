const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const onboardingController = require('../controllers/onboardingController');

router.post(
  '/connect-whatsapp',
  protect,
  onboardingController.connectWhatsApp
);

module.exports = router;
