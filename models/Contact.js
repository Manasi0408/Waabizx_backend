const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Contact = sequelize.define('Contact', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  name: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    validate: {
      isEmailOrEmpty(value) {
        if (value === null || value === undefined || String(value).trim() === '') return;
        const email = String(value).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error('Must be a valid email address');
        }
      },
    },
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive', 'unsubscribed'),
    defaultValue: 'active'
  },
  tags: {
    type: DataTypes.JSON,
    defaultValue: []
  },
  country: {
    type: DataTypes.STRING,
    defaultValue: null
  },
  country_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    defaultValue: null,
    field: 'country_code',
  },
  lastContacted: {
    type: DataTypes.DATE,
    defaultValue: null
  },
  lastCustomerMessageAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
    field: 'last_customer_message_at',
  },
  whatsappOptInAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },
  notes: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  customFields: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'CSV columns e.g. order_id, custom vars for campaign mapping'
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
  // Additional contact features (commented out - columns don't exist in DB yet)
  // avatar: {
  //   type: DataTypes.STRING,
  //   allowNull: true
  // },
  // isOnline: {
  //   type: DataTypes.BOOLEAN,
  //   defaultValue: false
  // },
  // lastSeen: {
  //   type: DataTypes.DATE,
  //   allowNull: true
  // },
  // isTyping: {
  //   type: DataTypes.BOOLEAN,
  //   defaultValue: false
  // }
}, {
  timestamps: true,
  tableName: 'contacts',
  // Exclude non-existent fields from default queries
  defaultScope: {
    attributes: {
      exclude: [] // All defined fields are valid
    }
  }
});

module.exports = Contact;