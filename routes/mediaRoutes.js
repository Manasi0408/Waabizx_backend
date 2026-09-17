const express = require('express');
const router = express.Router();
const mediaController = require('../controllers/mediaController');
const mediaPublicController = require('../controllers/mediaPublicController');
const { protect } = require('../middleware/authMiddleware');

// Public permanent media (no auth) — SuperAdmin, marketing site, Meta header link fetches
router.get('/public/{*path}', mediaPublicController.servePublicMedia);

// Upload media
router.post('/upload', protect, mediaController.upload.single('media'), mediaController.uploadMedia);

// Download/cache inbound WhatsApp media by Meta media ID
router.get('/whatsapp/:mediaId', protect, mediaController.getWhatsAppMedia);

// Send media message
router.post('/send', protect, mediaController.sendMediaMessage);

module.exports = router;
