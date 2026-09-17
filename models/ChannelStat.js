const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChannelStat = sequelize.define(
  'ChannelStat',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    channel: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'rcs',
    },
    sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    delivered: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    read: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    clicked: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'channel_stats',
    timestamps: true,
    indexes: [{ unique: true, fields: ['projectId', 'channel'] }],
  }
);

module.exports = ChannelStat;
