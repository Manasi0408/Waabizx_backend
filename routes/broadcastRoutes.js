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
router.post('/upload-header-media', protect, uploadHeaderMediaMiddleware, uploadHeaderMedia);

// Contact Selection
router.get('/contacts', protect, getContacts);
router.get('/segments', protect, getSegments);
router.get('/segments/:tag/contacts', protect, getContactsBySegment);

// Template Validation
router.post('/validate-template', protect, validateTemplate);

// Create Broadcast
router.post('/create', protect, createBroadcast);

module.exports = router;

