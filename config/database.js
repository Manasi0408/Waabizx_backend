const { Sequelize } = require("sequelize");

// Normalize host: Node often resolves "localhost" to ::1 (IPv6). MySQL users on shared hosting
// (e.g. Hostinger) are usually granted for 127.0.0.1, not ::1, which causes "Access denied".
const rawHost = process.env.DB_HOST || 'localhost';
const normalizedHost =
  rawHost === 'localhost' || rawHost === '::1' ? '127.0.0.1' : rawHost;

// Get environment variables with fallbacks
const dbConfig = {
  database: process.env.DB_NAME || 'aisensy_db',
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '', // Use empty if not set, don't use fallback password
  host: normalizedHost,
  port: process.env.DB_PORT || 3306,
  dialect: 'mysql',
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  define: {
    timestamps: true,
    underscored: false
  }
};

// Clean password - remove quotes if present (dotenv might add them)
// Handle both single and double quotes, and trim whitespace
let cleanPassword = dbConfig.password || '';
if (cleanPassword) {
  // Remove surrounding quotes (single or double)
  cleanPassword = cleanPassword.replace(/^["']|["']$/g, '');
  // Trim any whitespace
  cleanPassword = cleanPassword.trim();
}

// If password is empty after cleaning, use undefined (Sequelize handles this better)
// Sequelize will not send password field if it's undefined
const finalPassword = (cleanPassword && cleanPassword.trim() !== '') ? cleanPassword : undefined;

const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  finalPassword, // Use undefined for empty password, not empty string
  {
    host: dbConfig.host,
    port: dbConfig.port,
    dialect: dbConfig.dialect,
    logging: dbConfig.logging,
    pool: dbConfig.pool,
    define: dbConfig.define
  }
);

module.exports = sequelize;
