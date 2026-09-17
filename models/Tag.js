const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Tag = sequelize.define(
  'Tag',
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
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    color: {
      type: DataTypes.STRING(20),
      defaultValue: '#3B82F6',
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    timestamps: true,
    tableName: 'tags',
    indexes: [
      {
        unique: true,
        fields: ['projectId', 'name'],
      },
    ],
  }
);

module.exports = Tag;
