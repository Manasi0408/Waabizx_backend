const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatbotLiveSession = sequelize.define(
  'ChatbotLiveSession',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'project_id',
    },
    customerUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'customer_user_id',
    },
    customerName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'customer_name',
    },
    assignedAgentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'assigned_agent_id',
    },
    status: {
      type: DataTypes.ENUM('requesting', 'active', 'closed'),
      allowNull: false,
      defaultValue: 'requesting',
    },
    lastMessageAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_message_at',
    },
  },
  {
    tableName: 'chatbot_live_sessions',
    underscored: true,
    timestamps: true,
  }
);

module.exports = ChatbotLiveSession;
