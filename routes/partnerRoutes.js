const express = require('express');
const partnerController = require('../controllers/partnerController');
const { requirePartnerApiKey } = require('../middleware/partnerAuth');

const router = express.Router({ mergeParams: true });

// AiSensy Partner API v1 compatible paths
router.post('/:partnerId/business', requirePartnerApiKey, partnerController.createBusiness);
router.get('/:partnerId/business', requirePartnerApiKey, partnerController.listBusinesses);
router.get('/:partnerId/business/:businessId', requirePartnerApiKey, partnerController.getBusiness);
router.get('/:partnerId/probe', requirePartnerApiKey, partnerController.probeExternalApis);

module.exports = router;
