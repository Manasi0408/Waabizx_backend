const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const {
  upload,
  getCannedMessages,
  createCannedMessage,
  updateCannedMessage,
  deleteCannedMessage,
  toggleFavorite,
} = require('../controllers/cannedMessageController');

router.get('/', protect, getCannedMessages);
router.post('/', protect, upload.single('file'), createCannedMessage);
router.put('/:id', protect, upload.single('file'), updateCannedMessage);
router.delete('/:id', protect, deleteCannedMessage);
router.post('/:id/favorite', protect, toggleFavorite);

module.exports = router;

