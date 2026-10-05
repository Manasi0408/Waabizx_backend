const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Meta-style conversation billing tracker (rolling 24-hour window).
// IMPORTANT: table name is `realconversation` (not `conversations`).
const RealConversation = sequelize.define(
  'RealConversation',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    account_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    conversation_start: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    last_message_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'realconversation',
    timestamps: false,
  }
);

module.exports = RealConversation;

