const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatbotLiveMessage = sequelize.define(
  'ChatbotLiveMessage',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    sessionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'session_id',
    },
    senderRole: {
      type: DataTypes.ENUM('customer', 'agent', 'system'),
      allowNull: false,
      field: 'sender_role',
    },
    senderUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'sender_user_id',
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: 'chatbot_live_messages',
    underscored: true,
    timestamps: true,
  }
);

module.exports = ChatbotLiveMessage;
