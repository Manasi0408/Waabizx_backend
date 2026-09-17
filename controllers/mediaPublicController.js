const path = require('path');
const fs = require('fs');

const UPLOADS_ROOT = path.join(__dirname, '../uploads');

function mimeFromExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

function setPublicHeaders(res, contentType) {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  if (contentType) res.setHeader('Content-Type', contentType);
}

/**
 * GET /api/media/public/* — serve permanently stored upload files.
 * Path example: /api/media/public/blogs/blog-123.jpg
 * Maps to disk: backend/uploads/blogs/blog-123.jpg
 *
 * Production proxies only /api/* to Node, so this is the reliable public URL.
 */
exports.servePublicMedia = async (req, res) => {
  try {
    const rawPath = req.params.path;
    const rel = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
    const cleaned = rel.replace(/^\/+/, '').replace(/\\/g, '/');

    if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned)) {
      return res.status(400).json({ success: false, message: 'Invalid media path' });
    }

    const abs = path.resolve(UPLOADS_ROOT, cleaned);
    if (!abs.startsWith(path.resolve(UPLOADS_ROOT))) {
      return res.status(400).json({ success: false, message: 'Invalid media path' });
    }

    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      setPublicHeaders(res, mimeFromExt(abs));
      return res.sendFile(abs);
    }

    return res.status(404).json({ success: false, message: 'Media file not found' });
  } catch (error) {
    console.error('servePublicMedia:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to serve media' });
  }
};
