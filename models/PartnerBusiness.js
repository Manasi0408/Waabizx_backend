const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PartnerBusiness = sequelize.define(
  'PartnerBusiness',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    business_id: {
      type: DataTypes.STRING(24),
      allowNull: false,
      unique: true,
      comment: 'Partner API business id (AiSensy-compatible hex string)',
    },
    external_project_id: {
      type: DataTypes.STRING(24),
      allowNull: true,
      unique: true,
      comment: 'AiSensy-style project id returned in project_ids[]',
    },
    partner_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    project_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    display_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    company: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    contact: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(8),
      allowNull: true,
      defaultValue: 'INR',
    },
    timezone: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: 'Asia/Calcutta GMT+05:30',
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    direct_api_password_enc: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'AES-encrypted login password for Direct API JWT (server-side only)',
    },
    direct_api_jwt: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'AiSensy Direct API JWT Bearer token (per account) — used for /messages',
    },
    direct_api_jwt_expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Expiry for direct_api_jwt (from JWT exp or regenerate response)',
    },
  },
  {
    tableName: 'partner_businesses',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = PartnerBusiness;
