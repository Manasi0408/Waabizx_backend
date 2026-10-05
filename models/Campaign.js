const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Campaign = sequelize.define('Campaign', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  description: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  status: {
    type: DataTypes.ENUM('draft', 'PENDING', 'PROCESSING', 'COMPLETED', 'PAUSED', 'scheduled', 'active'),
    defaultValue: 'draft'
  },
  type: {
    type: DataTypes.ENUM('broadcast', 'automation', 'sequence'),
    defaultValue: 'broadcast'
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  template_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  template_language: {
    type: DataTypes.STRING,
    defaultValue: 'en_US'
  },
  variable_mapping: {
    type: DataTypes.JSON,
    defaultValue: null,
    comment: 'Map template vars e.g. { "1": "name", "2": "order_id" } for {{1}} {{2}}'
  },
  header_media_url: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
    comment: 'Public HTTPS URL for template HEADER image/video/document when sending'
  },
  template_header_format: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    comment: 'IMAGE, VIDEO, or DOCUMENT — required for media header templates at send time'
  },
  carousel_card_media_urls: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
    comment: 'Ordered public/stored URLs for each carousel card header at send time',
  },
  schedule_time: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  scheduledAt: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  completedAt: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  totalRecipients: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  total: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  sent: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  delivered: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  read: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  failed: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  opened: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  clicked: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  projectId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null
  }
}, {
  timestamps: true,
  tableName: 'campaigns'
});

module.exports = Campaign;