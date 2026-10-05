const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getUserAttributes,
  saveUserAttributes,
} = require('../controllers/userAttributeController');

router.get('/user-attributes', protect, getUserAttributes);
router.post('/user-attributes/save', protect, saveUserAttributes);

module.exports = router;
