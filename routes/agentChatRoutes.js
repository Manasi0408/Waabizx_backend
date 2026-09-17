const express = require("express");
const router = express.Router();

const chat = require("../controllers/agentChatController");
const webhook = require("../webhooks/whatsappWebhook");

router.get("/active", chat.getActiveChats);
router.get("/requesting", chat.getRequestingChats);
router.get("/intervened", chat.getIntervenedChats);
router.get("/messages/:id", chat.getChatMessages);
router.post("/send", chat.sendMessage);
router.post("/webhook", webhook.receiveMessage);

module.exports = router;
