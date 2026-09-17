const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ExchangeRate = sequelize.define(
  'ExchangeRate',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    base_currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    target_currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    rate: {
      type: DataTypes.DECIMAL(18, 10),
      allowNull: false,
    },
  },
  {
    tableName: 'exchange_rates',
    timestamps: true,
    createdAt: false,
    updatedAt: 'updated_at',
  }
);

module.exports = ExchangeRate;
