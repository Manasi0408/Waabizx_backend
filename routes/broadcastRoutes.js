const express = require('express');
const router = express.Router();
const {
  uploadCSV,
  parseCSV,
  getContacts,
  getSegments,
  getContactsBySegment,
  validateTemplate,
  createBroadcast,
  uploadHeaderMediaMiddleware,
  uploadHeaderMedia,
} = require('../controllers/broadcastController');
const { protect } = require('../middleware/authMiddleware');

// CSV Upload
router.post('/upload-csv', protect, uploadCSV, parseCSV);
router.post('/upload-header-media', protect, (req, res, next) => {
  uploadHeaderMediaMiddleware(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File is too large. Images up to 16 MB, documents up to 100 MB, videos up to 1 GB.',
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || 'Failed to upload header media',
      });
    }
    return uploadHeaderMedia(req, res);
  });
});

// Contact Selection
router.get('/contacts', protect, getContacts);
router.get('/segments', protect, getSegments);
router.get('/segments/:tag/contacts', protect, getContactsBySegment);

// Template Validation
router.post('/validate-template', protect, validateTemplate);

// Create Broadcast
router.post('/create', protect, createBroadcast);

module.exports = router;

