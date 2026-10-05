const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WhatsappPricing = sequelize.define(
  'WhatsappPricing',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    country_code: {
      type: DataTypes.STRING(5),
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },
    rate: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'INR',
    },
    effective_from: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    effective_to: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: 'whatsapp_pricing',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = WhatsappPricing;
