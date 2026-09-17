const express = require('express');
const directApiController = require('../controllers/directApiController');
const { requireDirectApiJwt } = require('../middleware/directApiAuth');

const router = express.Router();

// AiSensy-compatible path (note: "regenrate" spelling matches their API docs)
router.post('/t1/users/regenrate-token', directApiController.regenerateToken);
router.post('/t1/users/regenerate-token', directApiController.regenerateToken);

// Get Business Profile Details — AiSensy: GET /direct-apis/t1/get-profile
router.get('/t1/get-profile', requireDirectApiJwt, directApiController.getProfile);

// Get WABA Information — AiSensy: GET /direct-apis/t1/get-business-info?fields=...
router.get('/t1/get-business-info', requireDirectApiJwt, directApiController.getBusinessInfo);

// WhatsApp Cloud API — AiSensy: POST /direct-apis/t1/messages (phone_number_id in JSON body)
router.post('/t1/messages', requireDirectApiJwt, directApiController.sendMessageBody);
router.post('/t1/marketing_messages', requireDirectApiJwt, directApiController.sendMarketingMessageBody);
// Legacy path (phone id in URL) — kept for backward compatibility
router.post('/t1/:phoneNumberId/messages', requireDirectApiJwt, directApiController.sendMessage);
router.post(
  '/t1/:phoneNumberId/marketing_messages',
  requireDirectApiJwt,
  directApiController.sendMarketingMessage
);

module.exports = router;
