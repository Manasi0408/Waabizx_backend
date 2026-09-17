const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WhatsAppAccount = sequelize.define('WhatsAppAccount', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  client_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  business_id: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Meta Business Manager ID from Embedded Signup'
  },
  waba_id: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  phone_number_id: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  display_phone: {
    type: DataTypes.STRING(30),
    allowNull: true,
    comment: 'E.164 display phone from Meta Graph (display_phone_number)'
  },
  access_token: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  token_expiry: {
    type: DataTypes.DATE,
    allowNull: true
  },
  projectId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Inbox / webhook routing: which project this WABA number belongs to'
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: true,
    defaultValue: 'pending'
  },
  aisensy_solution_id: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Meta WhatsApp Business Solution ID (Embedded Signup partner billing)'
  },
  account_status: {
    type: DataTypes.STRING(20),
    allowNull: true,
    defaultValue: 'INACTIVE',
    comment: 'Messaging readiness: ACTIVE when Meta WhatsApp is linked'
  }
}, {
  tableName: 'whatsapp_accounts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = WhatsAppAccount;
