const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Stores reusable "canned" chat messages for live chat.
const CannedMessage = sequelize.define(
  'CannedMessage',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    // TEXT | IMAGE | FILE
    messageType: {
      type: DataTypes.ENUM('TEXT', 'IMAGE', 'FILE'),
      allowNull: false,
      defaultValue: 'TEXT',
    },
    text: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    mediaUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    mediaFilename: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isFavorite: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
    tableName: 'cannedmessages',
  }
);

module.exports = CannedMessage;

