const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");

const {
  getSettings,
  saveSettings,
} = require("../controllers/settingController");

// GET settings (protected)
router.get("/", protect, getSettings);

// CREATE / UPDATE settings (protected)
router.post("/", protect, saveSettings);

module.exports = router;
