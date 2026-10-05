const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('sent', 'delivered', 'read', 'failed'),
    defaultValue: 'sent'
  },
  type: {
    type: DataTypes.ENUM('outgoing', 'incoming'),
    defaultValue: 'outgoing'
  },
  sentAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  deliveredAt: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  readAt: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  errorMessage: {
    type: DataTypes.TEXT,
    defaultValue: null
  },
  campaignId: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  contactId: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  projectId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null
  },
  // Media support (commented out - columns don't exist in DB yet)
  // mediaType: {
  //   type: DataTypes.ENUM('text', 'image', 'video', 'audio', 'document', 'location', 'contact'),
  //   defaultValue: 'text'
  // },
  // mediaUrl: {
  //   type: DataTypes.TEXT,
  //   allowNull: true
  // },
  // mediaFilename: {
  //   type: DataTypes.STRING,
  //   allowNull: true
  // },
  // mediaSize: {
  //   type: DataTypes.INTEGER,
  //   allowNull: true
  // },
  // mediaMimeType: {
  //   type: DataTypes.STRING,
  //   allowNull: true
  // },
  // Message features (commented out - columns don't exist in DB yet)
  // replyToId: {
  //   type: DataTypes.INTEGER,
  //   allowNull: true,
  //   references: {
  //     model: 'Messages',
  //     key: 'id'
  //   }
  // },
  // forwardedFrom: {
  //   type: DataTypes.INTEGER,
  //   allowNull: true,
  //   references: {
  //     model: 'Messages',
  //     key: 'id'
  //   }
  // },
  reactions: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null
  },
  // isDeleted: {
  //   type: DataTypes.BOOLEAN,
  //   defaultValue: false
  // },
  // deletedAt: {
  //   type: DataTypes.DATE,
  //   allowNull: true
  // }
}, {
  timestamps: true,
  tableName: 'messages'
});

module.exports = Message;