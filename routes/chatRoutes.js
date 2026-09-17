const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const { protect } = require("../middleware/authMiddleware");
const { isManager, isAgent, isAgentOrManager } = require("../middleware/roleMiddleware");

// Webhook: public endpoint (no auth)
router.post("/webhook", chatController.receiveMessage);

// Manager: see all conversations (any status)
router.get(
  "/manager/conversations",
  protect,
  isManager,
  chatController.getManagerConversations
);

// Agent: see only conversations assigned to them
router.get(
  "/agent/conversations",
  protect,
  isAgent,
  chatController.getAgentConversations
);

// Existing filtered lists (can be used by manager views)
router.get("/conversations/:projectId", protect, chatController.getConversationsByProject);
router.get("/requesting", protect, chatController.getRequestingChats);
router.get(
  "/unassigned-requesting",
  protect,
  isAgentOrManager,
  chatController.getUnassignedRequesting
);
router.get("/active", protect, chatController.getActiveChats);
router.get("/history", protect, chatController.getHistoryChats);
router.get("/intervened", protect, chatController.getIntervenedChats);

// Messages within a conversation
router.get("/messages/:id", protect, chatController.getChatMessages);

// Agent actions on a conversation
router.post("/accept/:id", protect, isAgent, chatController.acceptChat);
router.post("/intervene/:id", protect, isAgent, chatController.interveneChat);
// Manager/Admin: intervene by phone (used from /inbox)
router.post("/intervene-by-phone", protect, isManager, chatController.interveneByPhone);
router.post("/message", protect, isAgentOrManager, chatController.sendMessage);
router.post("/send-template", protect, isAgentOrManager, chatController.sendTemplateMessage);
router.post("/close/:id", protect, isAgentOrManager, chatController.closeChat);

// Manager: assign chat to an agent
router.post(
  "/assign",
  protect,
  isManager,
  chatController.assignChat
);

// Optional: alias matching example name (/api/assign-agent)
router.post(
  "/assign-agent",
  protect,
  isAgentOrManager,
  chatController.assignAgentTakeover
);

module.exports = router;
