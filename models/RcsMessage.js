const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RcsMessage = sequelize.define(
  'RcsMessage',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    contactId: { type: DataTypes.INTEGER, allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: false, defaultValue: '' },
    contactName: { type: DataTypes.STRING(160), allowNull: true },
    channel: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'rcs',
    },
    messageType: {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'text',
      comment: 'text|image|video|pdf|card|carousel|buttons',
    },
    message: { type: DataTypes.TEXT, allowNull: true },
    content: { type: DataTypes.TEXT, allowNull: true, comment: 'JSON payload for rich types' },
    direction: {
      type: DataTypes.ENUM('incoming', 'outgoing'),
      allowNull: false,
      defaultValue: 'outgoing',
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'sent',
    },
    providerMessageId: { type: DataTypes.STRING(120), allowNull: true },
    campaignId: { type: DataTypes.INTEGER, allowNull: true },
    clickedButton: { type: DataTypes.STRING(120), allowNull: true },
  },
  {
    tableName: 'rcs_messages',
    timestamps: true,
    indexes: [
      { fields: ['projectId'] },
      { fields: ['phone'] },
      { fields: ['providerMessageId'] },
      { fields: ['channel'] },
    ],
  }
);

module.exports = RcsMessage;
