const express = require('express');
const router = express.Router();
const {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  getMetaTemplates,
  createMetaTemplate,
  getMetaTemplateDetails,
  uploadTemplateHeaderPreviewMiddleware,
  uploadTemplateHeaderPreview,
  serveTemplateHeaderImage,
} = require('../controllers/templateController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createTemplate);
router.post('/create', protect, createMetaTemplate);
router.post('/header-preview', protect, uploadTemplateHeaderPreviewMiddleware, uploadTemplateHeaderPreview);
router.get('/', protect, getTemplates);
router.get('/meta', protect, getMetaTemplates);
router.get('/meta/:templateId', protect, getMetaTemplateDetails);
// Permanent header image (disk + DB base64) — before /:id
router.get('/:id/header-image', serveTemplateHeaderImage);
router.get('/:id', protect, getTemplateById);
router.put('/:id', protect, updateTemplate);
router.delete('/:id', protect, deleteTemplate);

module.exports = router;
