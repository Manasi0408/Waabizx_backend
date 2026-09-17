const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WhatsAppButton = sequelize.define(
  'WhatsAppButton',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    publicId: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
      defaultValue: 'Chat with us',
    },
    ctaColor: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '#4DC247',
    },
    marginLeft: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    marginRight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    marginTop: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    marginBottom: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    cornerRadius: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 25,
    },
    prefillMessage: {
      type: DataTypes.STRING(140),
      allowNull: false,
      defaultValue: 'Hi',
    },
    position: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'bottom-right',
    },
    widgetHeading: {
      type: DataTypes.STRING(160),
      allowNull: false,
      defaultValue: '',
    },
    widgetButtonText: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: 'Start chat',
    },
    widgetButtonColor: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '#0A5F54',
    },
    widgetProfileUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    widgetPrefillMessage: {
      type: DataTypes.STRING(280),
      allowNull: false,
      defaultValue: 'Hi, how can I help you?',
    },
    phoneNumber: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: '',
    },
    embedScript: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    widgetVisits: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    qrVisits: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: 'whatsapp_buttons',
    indexes: [
      { fields: ['projectId'] },
      { unique: true, fields: ['publicId'] },
    ],
  }
);

module.exports = WhatsAppButton;
