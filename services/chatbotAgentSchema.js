const sequelize = require('../config/database');
const ChatbotAgentSession = require('../models/ChatbotAgentSession');
const ChatbotAgentMessage = require('../models/ChatbotAgentMessage');

let ensured = false;

async function ensureChatbotAgentSchema() {
  if (ensured) return;
  await ChatbotAgentSession.sync({ alter: true });
  await ChatbotAgentMessage.sync({ alter: true });
  try {
    await sequelize.query(`
      ALTER TABLE users
      MODIFY COLUMN role ENUM(
        'admin','super_admin','manager','agent','user','chatbot_agent'
      ) NOT NULL DEFAULT 'admin'
    `);
  } catch (e) {
    console.warn('[chatbot-agent] users.role enum:', e?.message || e);
  }
  ensured = true;
}

module.exports = { ensureChatbotAgentSchema };
