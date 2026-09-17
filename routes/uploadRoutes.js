const express = require('express');
const router = express.Router();
const upload = require('../middleware/mediaUpload');
const { protect } = require('../middleware/authMiddleware');
const uploadController = require('../controllers/uploadController');

router.post(
  '/upload',
  protect,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message || 'File upload failed',
        });
      }
      return next();
    });
  },
  uploadController.uploadFile
);

module.exports = router;
