const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RcsCampaign = sequelize.define(
  'RcsCampaign',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    channel: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'rcs',
    },
    messageType: {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'text',
    },
    content: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'draft',
    },
    totalRecipients: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    delivered: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: 'rcs_campaigns',
    timestamps: true,
  }
);

module.exports = RcsCampaign;
