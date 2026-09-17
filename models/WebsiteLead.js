const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const db = require('../config/db');

const WebsiteLead = sequelize.define(
  'WebsiteLead',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    full_name: { type: DataTypes.STRING(160), allowNull: false, defaultValue: '' },
    email: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
    phone: { type: DataTypes.STRING(40), allowNull: false, defaultValue: '' },
    country: { type: DataTypes.STRING(120), allowNull: true, defaultValue: '' },
    industry: { type: DataTypes.STRING(160), allowNull: true, defaultValue: '' },
    heard_about: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: '',
      comment: 'How did you hear about us',
    },
    company_size: { type: DataTypes.STRING(80), allowNull: true, defaultValue: '' },
    subject: { type: DataTypes.STRING(255), allowNull: true, defaultValue: '' },
    message: { type: DataTypes.TEXT, allowNull: true, defaultValue: '' },
    descriptions: { type: DataTypes.TEXT, allowNull: true, defaultValue: '' },
    status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'new',
      comment: 'new|contacted|closed',
    },
  },
  {
    tableName: 'website_leads',
    timestamps: true,
    indexes: [
      { fields: ['email'] },
      { fields: ['status'] },
      { fields: ['createdAt'] },
      { fields: ['country'] },
    ],
  }
);

let schemaReady = false;

WebsiteLead.ensureSchema = async function ensureWebsiteLeadSchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS website_leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(160) NOT NULL DEFAULT '',
      email VARCHAR(200) NOT NULL DEFAULT '',
      phone VARCHAR(40) NOT NULL DEFAULT '',
      country VARCHAR(120) NULL DEFAULT '',
      industry VARCHAR(160) NULL DEFAULT '',
      heard_about VARCHAR(200) NULL DEFAULT '',
      company_size VARCHAR(80) NULL DEFAULT '',
      subject VARCHAR(255) NULL DEFAULT '',
      message TEXT NULL,
      descriptions TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'new',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX website_leads_email (email),
      INDEX website_leads_status (status),
      INDEX website_leads_createdAt (createdAt)
    )
  `);

  const columns = [
    ['country', 'VARCHAR(120) NULL DEFAULT \'\''],
    ['industry', 'VARCHAR(160) NULL DEFAULT \'\''],
    ['heard_about', 'VARCHAR(200) NULL DEFAULT \'\''],
    ['company_size', 'VARCHAR(80) NULL DEFAULT \'\''],
    ['subject', 'VARCHAR(255) NULL DEFAULT \'\''],
    ['message', 'TEXT NULL'],
    ['descriptions', 'TEXT NULL'],
  ];

  for (const [col, def] of columns) {
    try {
      const [rows] = await db.query(`SHOW COLUMNS FROM website_leads LIKE ?`, [col]);
      if (!Array.isArray(rows) || rows.length === 0) {
        await db.query(`ALTER TABLE website_leads ADD COLUMN ${col} ${def}`);
      }
    } catch (e) {
      console.error(`Could not ensure website_leads.${col}:`, e?.message || e);
    }
  }

  schemaReady = true;
};

module.exports = WebsiteLead;
