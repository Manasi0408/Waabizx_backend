const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Multi-tenant account record for WhatsApp conversation billing quota.
// Note: table name is `accounts` (your DB may already have a similar structure; this is for new billing logic).
const Account = sequelize.define(
  'Account',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    conversation_limit: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 10000,
    },
  },
  {
    tableName: 'accounts',
    timestamps: false,
  }
);

module.exports = Account;

