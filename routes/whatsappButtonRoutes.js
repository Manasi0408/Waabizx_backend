const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  listWhatsAppButtons,
  createWhatsAppButton,
  deleteWhatsAppButton,
  publicRedirect,
  publicTrackVisit,
} = require('../controllers/whatsappButtonController');

router.get('/public/:publicId/r', publicRedirect);
router.get('/public/:publicId/visit', publicTrackVisit);
router.post('/public/:publicId/visit', publicTrackVisit);

router.get('/', protect, listWhatsAppButtons);
router.post('/', protect, createWhatsAppButton);
router.delete('/:id', protect, deleteWhatsAppButton);

module.exports = router;
