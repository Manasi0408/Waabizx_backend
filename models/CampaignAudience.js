const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CampaignAudience = sequelize.define('CampaignAudience', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  campaignId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'campaigns',
      key: 'id'
    }
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },
  var1: {
    type: DataTypes.STRING,
    allowNull: true
  },
  var2: {
    type: DataTypes.STRING,
    allowNull: true
  },
  var3: {
    type: DataTypes.STRING,
    allowNull: true
  },
  var4: {
    type: DataTypes.STRING,
    allowNull: true
  },
  var5: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'sent', 'delivered', 'read', 'failed'),
    defaultValue: 'pending'
  },
  waMessageId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sentAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  deliveredAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  readAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  timestamps: true,
  tableName: 'campaignaudiences'
});

module.exports = CampaignAudience;

