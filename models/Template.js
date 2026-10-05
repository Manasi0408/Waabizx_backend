const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Template = sequelize.define('Template', {
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
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  category: {
    type: DataTypes.ENUM('welcome', 'promotional', 'marketing', 'utility', 'transactional', 'notification', 'other'),
    defaultValue: 'other'
  },
  status: {
    type: DataTypes.ENUM('draft', 'approved', 'rejected'),
    defaultValue: 'draft'
  },
  metaTemplateId: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null
  },
  metaStatus: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null
  },
  rejectionReason: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null
  },
  rejectionInfo: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  },
  rejectionRecommendation: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  },
  variables: {
    type: DataTypes.JSON,
    defaultValue: []
  },
  usageCount: {
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
  },
  deletedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  }
}, {
  timestamps: true,
  tableName: 'templates'
});

module.exports = Template;