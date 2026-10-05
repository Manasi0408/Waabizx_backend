const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const db = require('../config/db');

const DemoBooking = sequelize.define(
  'DemoBooking',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    full_name: { type: DataTypes.STRING(160), allowNull: false, defaultValue: '' },
    email: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
    phone: { type: DataTypes.STRING(40), allowNull: false, defaultValue: '' },
    company_size: { type: DataTypes.STRING(80), allowNull: true, defaultValue: '' },
    country: { type: DataTypes.STRING(120), allowNull: true, defaultValue: '' },
    industry: { type: DataTypes.STRING(160), allowNull: true, defaultValue: '' },
    heard_about: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: '',
      comment: 'How did you hear about us',
    },
    interest: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: '',
      comment: 'What would you like to do with Waabizx',
    },
    descriptions: { type: DataTypes.TEXT, allowNull: true, defaultValue: '' },
    status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'new',
      comment: 'new|contacted|closed',
    },
  },
  {
    tableName: 'demo_bookings',
    timestamps: true,
    indexes: [{ fields: ['email'] }, { fields: ['status'] }, { fields: ['createdAt'] }, { fields: ['country'] }],
  }
);

let schemaReady = false;

/**
 * Ensure demo_bookings exists and has the Book Demo form columns.
 * Safe to call on every request (runs once successfully).
 */
DemoBooking.ensureSchema = async function ensureDemoBookingSchema() {
  if (schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS demo_bookings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(160) NOT NULL DEFAULT '',
      email VARCHAR(200) NOT NULL DEFAULT '',
      phone VARCHAR(40) NOT NULL DEFAULT '',
      company_size VARCHAR(80) NULL DEFAULT '',
      country VARCHAR(120) NULL DEFAULT '',
      industry VARCHAR(160) NULL DEFAULT '',
      heard_about VARCHAR(200) NULL DEFAULT '',
      interest VARCHAR(200) NULL DEFAULT '',
      descriptions TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'new',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX demo_bookings_email (email),
      INDEX demo_bookings_status (status),
      INDEX demo_bookings_createdAt (createdAt)
    )
  `);

  const columns = [
    ['country', 'VARCHAR(120) NULL DEFAULT \'\''],
    ['industry', 'VARCHAR(160) NULL DEFAULT \'\''],
    ['heard_about', 'VARCHAR(200) NULL DEFAULT \'\''],
    ['interest', 'VARCHAR(200) NULL DEFAULT \'\''],
    ['company_size', 'VARCHAR(80) NULL DEFAULT \'\''],
    ['descriptions', 'TEXT NULL'],
  ];

  for (const [col, def] of columns) {
    try {
      const [rows] = await db.query(`SHOW COLUMNS FROM demo_bookings LIKE ?`, [col]);
      if (!Array.isArray(rows) || rows.length === 0) {
        await db.query(`ALTER TABLE demo_bookings ADD COLUMN ${col} ${def}`);
      }
    } catch (e) {
      console.error(`Could not ensure demo_bookings.${col}:`, e?.message || e);
    }
  }

  schemaReady = true;
};

module.exports = DemoBooking;
