const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const InboxMessage = sequelize.define('InboxMessage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  contactId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'contacts',
      key: 'id'
    }
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  projectId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null
  },
  direction: {
    type: DataTypes.ENUM('incoming', 'outgoing'),
    allowNull: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('text', 'image', 'video', 'audio', 'document'),
    defaultValue: 'text'
  },
  status: {
    type: DataTypes.ENUM('sent', 'delivered', 'read', 'failed'),
    defaultValue: 'sent'
  },
  isTemplateSend: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  templateName: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null
  },
  templateSnapshot: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  },
  payload: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  mediaUrl: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  waMessageId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  timestamps: true,
  tableName: 'inboxmessages'
});

module.exports = InboxMessage;

