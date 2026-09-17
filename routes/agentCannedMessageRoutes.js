const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/roleMiddleware");
const {
  upload,
  getCannedMessages,
  createCannedMessage,
  updateCannedMessage,
  deleteCannedMessage,
  toggleFavorite,
} = require("../controllers/cannedMessageController");

// Agent/admin canned messages endpoints (used by the agent-manage UI)
router.get("/", protect, authorize("agent", "admin"), getCannedMessages);
router.post("/", protect, authorize("agent", "admin"), upload.single("file"), createCannedMessage);
router.put("/:id", protect, authorize("agent", "admin"), upload.single("file"), updateCannedMessage);
router.delete("/:id", protect, authorize("agent", "admin"), deleteCannedMessage);
router.post("/:id/favorite", protect, authorize("agent", "admin"), toggleFavorite);

module.exports = router;

