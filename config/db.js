const mysql = require('mysql2/promise');

const rawHost = process.env.DB_HOST || 'localhost';
const normalizedHost =
  rawHost === 'localhost' || rawHost === '::1' ? '127.0.0.1' : rawHost;

let cleanPassword = process.env.DB_PASSWORD || '';
if (cleanPassword) {
  cleanPassword = cleanPassword.replace(/^["']|["']$/g, '').trim();
}

const mysqlPoolMax = Math.min(
  50,
  Math.max(5, parseInt(String(process.env.DB_POOL_MAX || '20'), 10) || 20)
);

// Reuse existing DB_* envs already used by Sequelize config
const pool = mysql.createPool({
  host: normalizedHost,
  user: process.env.DB_USER || 'root',
  password: cleanPassword || undefined,
  database: process.env.DB_NAME || 'aisensy_db',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  connectionLimit: mysqlPoolMax,
  queueLimit: 0,
});

module.exports = pool;

