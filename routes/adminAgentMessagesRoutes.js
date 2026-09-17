const express = require("express");
const router = express.Router();
const adminAgentMessagesController = require("../controllers/adminAgentMessagesController");
const { protect } = require("../middleware/authMiddleware");

// Admin: all messages (protected)
router.get("/messages", protect, adminAgentMessagesController.getAllMessages);

// Agent: only assigned messages (protected)
router.get("/agent/messages", protect, adminAgentMessagesController.getAgentMessages);

module.exports = router;
