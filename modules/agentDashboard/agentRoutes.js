const express = require("express");
const router = express.Router();
const agentController = require("./agentController");

router.get("/agent/whatsapp-status", agentController.getAgentDashboard);

module.exports = router;
