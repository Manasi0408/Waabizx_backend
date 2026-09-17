const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const { protect } = require("../middleware/authMiddleware");
const { isManager, isAgent } = require("../middleware/roleMiddleware");

// Manager Inbox: all requesting chats (for assign flow)
router.get(
  "/manager/requesting",
  protect,
  isManager,
  chatController.getManagerRequesting
);

// Agent Requesting Tab: chats assigned to this agent, status=requesting
router.get(
  "/agent/requesting",
  protect,
  isAgent,
  chatController.getAgentRequesting
);

// Assign conversation to agent (status stays requesting → Agent Requesting tab)
router.post("/assign", protect, isManager, chatController.assignChat);

module.exports = router;
