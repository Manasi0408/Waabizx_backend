const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AgentProject = sequelize.define(
  'AgentProject',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    agentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'agent_id',
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'project_id',
    },
    assignedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
      field: 'assigned_by',
    },
    assignedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'assigned_at',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'is_active',
    },
  },
  {
    tableName: 'agent_projects',
    freezeTableName: true,
    timestamps: false,
    indexes: [
      { unique: true, fields: ['agent_id', 'project_id'] },
      { fields: ['agent_id'] },
      { fields: ['project_id'] },
      { fields: ['is_active'] },
    ],
  }
);

module.exports = AgentProject;
