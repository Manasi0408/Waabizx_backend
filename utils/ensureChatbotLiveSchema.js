const ChatbotLiveSession = require('../models/ChatbotLiveSession');
const ChatbotLiveMessage = require('../models/ChatbotLiveMessage');

let ensured = false;

async function ensureChatbotLiveSchema() {
  if (ensured) return;
  await ChatbotLiveSession.sync({ alter: true });
  await ChatbotLiveMessage.sync({ alter: true });
  ensured = true;
}

module.exports = { ensureChatbotLiveSchema };
