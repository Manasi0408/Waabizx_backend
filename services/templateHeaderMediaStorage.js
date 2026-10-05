const fs = require('fs');
const path = require('path');
const { toPermanentUploadPath } = require('../utils/templateMessageComponents');

function mimeToExtension(mimeType, fallback = 'png') {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf',
  };
  return map[String(mimeType || '').toLowerCase()] || fallback;
}

function extensionToMime(ext) {
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
  };
  return map[String(ext || '').toLowerCase()] || 'image/png';
}

function resolveUploadAbsolutePath(relativeOrUrl) {
  const rel = toPermanentUploadPath(relativeOrUrl) || String(relativeOrUrl || '').trim();
  if (!rel.startsWith('/uploads/')) return null;
  return path.join(__dirname, '..', rel.replace(/^\//, ''));
}

function saveTemplateHeaderMediaToUploads(headerMedia, templateName) {
  if (!headerMedia?.data) return null;

  const buffer = Buffer.from(String(headerMedia.data), 'base64');
  if (!buffer.length) return null;

  const uploadDir = path.join(__dirname, '../uploads/templates');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const safeName = String(templateName || 'template')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 48) || 'template';

  const ext = mimeToExtension(headerMedia.mimeType, 'png');
  const filename = `${safeName}-header-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);

  return `/uploads/templates/${filename}`;
}

/** Copy an existing /uploads/... header file for a new/copied template name. */
function copyTemplateHeaderMedia(existingUrl, templateName) {
  const abs = resolveUploadAbsolutePath(existingUrl);
  if (!abs || !fs.existsSync(abs)) return null;

  const uploadDir = path.join(__dirname, '../uploads/templates');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const safeName = String(templateName || 'template')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 48) || 'template';

  const ext = path.extname(abs).replace(/^\./, '') || 'png';
  const filename = `${safeName}-header-${Date.now()}.${ext}`;
  fs.copyFileSync(abs, path.join(uploadDir, filename));
  return `/uploads/templates/${filename}`;
}

/** Load stored upload as headerMedia object for Meta create/update. */
function loadHeaderMediaFromUpload(existingUrl) {
  const abs = resolveUploadAbsolutePath(existingUrl);
  if (!abs || !fs.existsSync(abs)) return null;
  const ext = path.extname(abs).replace(/^\./, '') || 'png';
  const buffer = fs.readFileSync(abs);
  if (!buffer.length) return null;
  return {
    data: buffer.toString('base64'),
    mimeType: extensionToMime(ext),
    fileName: path.basename(abs),
  };
}

module.exports = {
  saveTemplateHeaderMediaToUploads,
  copyTemplateHeaderMedia,
  loadHeaderMediaFromUpload,
  resolveUploadAbsolutePath,
};
