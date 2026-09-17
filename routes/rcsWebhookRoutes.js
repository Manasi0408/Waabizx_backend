const express = require('express');
const router = express.Router();
const { handleRcsWebhook } = require('../controllers/rcsController');

router.post('/', handleRcsWebhook);
router.post('/events', handleRcsWebhook);

module.exports = router;
