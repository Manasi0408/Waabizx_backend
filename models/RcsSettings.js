const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RcsSettings = sequelize.define(
  'RcsSettings',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    agentId: { type: DataTypes.STRING(120), allowNull: true, defaultValue: '' },
    apiKey: { type: DataTypes.TEXT, allowNull: true, defaultValue: '' },
    webhookUrl: { type: DataTypes.TEXT, allowNull: true, defaultValue: '' },
    brandName: { type: DataTypes.STRING(160), allowNull: true, defaultValue: '' },
    provider: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'mock',
      comment: 'mock|google',
    },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: 'rcs_settings',
    timestamps: true,
  }
);

module.exports = RcsSettings;
