const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Blog = sequelize.define(
  'Blog',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: '',
    },
    blog_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    created_by: {
      type: DataTypes.STRING(160),
      allowNull: false,
      defaultValue: '',
    },
    image_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    meta_title: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: '',
    },
    meta_description: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '',
    },
    meta_keywords: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: '',
    },
    details: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      defaultValue: '',
      comment: 'HTML blog body (bold, underline, links, fonts, etc.)',
    },
    created_by_user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'blogs',
    timestamps: true,
    indexes: [
      { fields: ['blog_date'] },
      { fields: ['is_active'] },
      { fields: ['createdAt'] },
    ],
  }
);

module.exports = Blog;
