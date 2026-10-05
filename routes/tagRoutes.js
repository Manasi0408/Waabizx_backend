const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  createTag,
  getTags,
  updateTag,
  deleteTag,
  assignContactTag,
  removeContactTag,
  getContactTags,
} = require('../controllers/tagController');

router.post('/tags', protect, createTag);
router.get('/tags', protect, getTags);
router.put('/tags/:id', protect, updateTag);
router.delete('/tags/:id', protect, deleteTag);

router.post('/contact-tags', protect, assignContactTag);
router.delete('/contact-tags', protect, removeContactTag);
router.get('/contact/:contactId/tags', protect, getContactTags);

module.exports = router;
