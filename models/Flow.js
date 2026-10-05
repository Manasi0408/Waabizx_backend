const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Stores visual workflow graphs as JSON (nodes + edges).
const Flow = sequelize.define(
  "Flow",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    projectId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    status: {
      type: DataTypes.ENUM('draft', 'published'),
      allowNull: false,
      defaultValue: 'draft',
    },
    metaFlowId: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: null,
    },
    metaEndpointUri: {
      type: DataTypes.STRING(512),
      allowNull: true,
      defaultValue: null,
    },
    // We store as TEXT to be safe across MySQL configurations.
    data: {
      type: DataTypes.TEXT("long"),
      allowNull: false,
    },
  },
  {
    timestamps: true,
    tableName: 'flows',
  }
);

module.exports = Flow;

