const express = require('express');
const router = express.Router();
const {
  createContact,
  getContacts,
  getContactById,
  importContacts,
  uploadCSV,
  parseAndSaveContactsCSV,
  updateContact,
  optOutContact,
  optInContact,
  deleteContact
} = require('../controllers/contactController');
const { protect } = require('../middleware/authMiddleware');

router.post('/', protect, createContact);
router.get('/', protect, getContacts);
router.post('/upload-csv', protect, uploadCSV, parseAndSaveContactsCSV);
router.get('/:id', protect, getContactById);
router.post('/import', protect, importContacts);
router.put('/:id', protect, updateContact);
router.put('/:id/opt-out', protect, optOutContact);
router.put('/:id/opt-in', protect, optInContact);
router.delete('/:id', protect, deleteContact);

module.exports = router;