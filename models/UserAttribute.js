const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserAttribute = sequelize.define(
  'UserAttribute',
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
      type: DataTypes.STRING(120),
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    timestamps: true,
    tableName: 'user_attributes',
    indexes: [
      {
        unique: true,
        fields: ['projectId', 'name'],
      },
    ],
  }
);

module.exports = UserAttribute;
