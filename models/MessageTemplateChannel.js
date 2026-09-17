const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MessageTemplateChannel = sequelize.define(
  'MessageTemplateChannel',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    channel: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'rcs',
    },
    type: {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'text',
      comment: 'text|image|card|carousel|buttons',
    },
    name: { type: DataTypes.STRING(160), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: true, comment: 'JSON content' },
  },
  {
    tableName: 'message_templates_channel',
    timestamps: true,
    indexes: [{ fields: ['projectId', 'channel'] }],
  }
);

module.exports = MessageTemplateChannel;
