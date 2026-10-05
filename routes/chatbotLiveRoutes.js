const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const chatbotLiveController = require('../controllers/chatbotLiveController');

const router = express.Router();

router.use(protect);

router.post('/request', chatbotLiveController.requestManualAgent);
router.get('/my-session', chatbotLiveController.getMySession);
router.post('/sessions/:sessionId/customer-message', chatbotLiveController.customerSendMessage);
router.post('/sessions/:sessionId/end', chatbotLiveController.endMySession);

router.get('/agent/queue', chatbotLiveController.listAgentQueue);
router.post('/agent/sessions/:sessionId/accept', chatbotLiveController.acceptSession);
router.post('/agent/sessions/:sessionId/message', chatbotLiveController.agentSendMessage);
router.post('/agent/sessions/:sessionId/close', chatbotLiveController.closeSessionAsAgent);
router.get('/sessions/:sessionId/messages', chatbotLiveController.getSessionMessages);
router.get('/sessions/:sessionId/history', chatbotLiveController.getSessionHistory);

module.exports = router;
