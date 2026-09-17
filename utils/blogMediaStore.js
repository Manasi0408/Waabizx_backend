const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');

const blogUploadDir = path.join(__dirname, '../uploads/blogs');

async function ensureBlogMediaTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS blog_media (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL DEFAULT 'image/jpeg',
      data LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_blog_media_filename (filename)
    )
  `);
}

function ensureBlogUploadDir() {
  if (!fs.existsSync(blogUploadDir)) {
    fs.mkdirSync(blogUploadDir, { recursive: true });
  }
}

async function saveBlogMedia(filename, buffer, mimeType = 'image/jpeg') {
  const name = String(filename || '').trim();
  if (!name || !buffer?.length) return false;

  await ensureBlogMediaTable();
  ensureBlogUploadDir();

  try {
    fs.writeFileSync(path.join(blogUploadDir, name), buffer);
  } catch (error) {
    console.error('blogMediaStore disk write error:', error.message || error);
  }

  await sequelize.query(
    `INSERT INTO blog_media (filename, mime_type, data)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), data = VALUES(data), created_at = CURRENT_TIMESTAMP`,
    { replacements: [name, String(mimeType || 'image/jpeg'), buffer] }
  );

  return true;
}

async function saveBlogMediaFromPath(filename, absPath, mimeType = 'image/jpeg') {
  if (!filename || !absPath || !fs.existsSync(absPath)) return false;
  const buffer = fs.readFileSync(absPath);
  return saveBlogMedia(filename, buffer, mimeType);
}

async function getBlogMedia(filename) {
  const name = String(filename || '').trim();
  if (!name) return null;

  await ensureBlogMediaTable();

  const [rows] = await sequelize.query(
    'SELECT filename, mime_type, data FROM blog_media WHERE filename = ? LIMIT 1',
    { replacements: [name] }
  );

  const row = rows?.[0];
  if (row?.data) {
    return {
      filename: row.filename,
      mimeType: row.mime_type || 'image/jpeg',
      buffer: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
    };
  }

  const abs = path.join(blogUploadDir, name);
  if (!fs.existsSync(abs)) return null;

  const buffer = fs.readFileSync(abs);
  const ext = path.extname(name).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';
  await saveBlogMedia(name, buffer, mimeType);
  return { filename: name, mimeType, buffer };
}

function filenameFromStoredPath(storedPath) {
  const match = String(storedPath || '').match(/\/uploads\/blogs\/([^/?#]+)$/i);
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = {
  saveBlogMedia,
  saveBlogMediaFromPath,
  getBlogMedia,
  filenameFromStoredPath,
};
