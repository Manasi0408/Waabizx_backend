const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ContactTag = sequelize.define(
  'ContactTag',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    contactId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tagId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    timestamps: true,
    updatedAt: false,
    tableName: 'contact_tags',
    indexes: [
      {
        unique: true,
        fields: ['contactId', 'tagId'],
      },
    ],
  }
);

module.exports = ContactTag;
