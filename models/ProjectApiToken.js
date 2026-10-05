const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ProjectApiToken = sequelize.define(
  'ProjectApiToken',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    projectName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    tokenPrefix: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    tokenPlain: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    allowedIp: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    allowedDomain: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    templateId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: 'project_api_tokens',
    timestamps: true,
  }
);

module.exports = ProjectApiToken;
