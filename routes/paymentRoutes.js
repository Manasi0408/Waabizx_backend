const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const {
  createWccOrder,
  verifyWccPayment,
} = require('../controllers/paymentController');

router.post('/create-order', protect, createWccOrder);
router.post('/verify-payment', protect, verifyWccPayment);

module.exports = router;
