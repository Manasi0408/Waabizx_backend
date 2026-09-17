const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const { protect } = require('../middleware/authMiddleware');
const profileController = require('../controllers/profileController');
const directApiController = require('../controllers/directApiController');

router.get('/profile', protect, profileController.getBusinessProfile);

// Dashboard check helpers — call AiSensy Direct API get-profile / get-business-info
router.get('/profile/whatsapp', protect, directApiController.getProfileForSession);
router.get('/profile/waba-info', protect, directApiController.getBusinessInfoForSession);

router.put(
  '/profile',
  protect,
  (req, res, next) => {
    upload.single('logo')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  profileController.updateProfile
);

module.exports = router;
