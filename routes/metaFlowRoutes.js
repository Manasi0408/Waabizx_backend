const express = require('express');
const { handleFlowEndpoint } = require('../controllers/metaFlowController');

const router = express.Router();

router.post('/flow', handleFlowEndpoint);

module.exports = router;
