const path = require('path');
const fs = require('fs');
const { toPublicMediaUrl } = require('../utils/templateMessageComponents');
const UPLOADS_ROOT = path.join(__dirname, '../uploads');

const VIDEO_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

function inferMediaType(mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

function buildStoredPath(file) {
  if (!file?.path) return null;
  const relativePath = path.relative(UPLOADS_ROOT, file.path).replace(/\\/g, '/');
  return `/uploads/${relativePath}`;
}

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
    }

    const mediaType = inferMediaType(req.file.mimetype);
    const maxBytes =
      mediaType === 'VIDEO'
        ? VIDEO_MAX_BYTES
        : mediaType === 'DOCUMENT'
          ? DOCUMENT_MAX_BYTES
          : IMAGE_MAX_BYTES;
    if (req.file.size > maxBytes) {
      try {
        if (req.file.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (_) {
        /* ignore */
      }
      const limitLabel = mediaType === 'VIDEO' ? '1 GB' : mediaType === 'DOCUMENT' ? '100 MB' : '16 MB';
      return res.status(400).json({
        success: false,
        message: `${mediaType === 'VIDEO' ? 'Video' : mediaType === 'DOCUMENT' ? 'Document' : 'Image'} file is too large. Maximum size is ${limitLabel}.`,
      });
    }

    const storedPath = buildStoredPath(req.file);
    const publicUrl = toPublicMediaUrl(storedPath);
    const fallbackUrl = `${req.protocol}://${req.get('host')}${storedPath}`;
    const fileUrl = publicUrl || fallbackUrl;

    return res.status(200).json({      success: true,
      message: 'File uploaded successfully',
      url: fileUrl,
      storedPath,
      mediaType,
      file: {
        originalName: req.file.originalname,
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: fileUrl,
        storedPath,
        mediaType,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'File upload failed',
    });
  }
};
