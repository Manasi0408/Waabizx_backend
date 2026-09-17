const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadPath = path.join(__dirname, '../uploads');

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

['images', 'videos', 'documents', 'audio'].forEach((folder) => {
  const dir = path.join(uploadPath, folder);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function resolveUploadFolder(mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'images';
  if (mime.startsWith('video/')) return 'videos';
  if (mime.startsWith('audio/')) return 'audio';
  return 'documents';
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = resolveUploadFolder(file.mimetype);
    cb(null, path.join(uploadPath, folder));
  },
  filename(req, file, cb) {
    const uniqueName =
      `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '')}`;
    cb(null, uniqueName);
  },
});

const allowedTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-m4v',
  'video/mpeg',
  'application/octet-stream',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const fileFilter = (req, file, cb) => {
  const mime = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  const videoExt = /\.(mp4|3gp|mov|avi|mkv|webm|m4v|mpeg|mpg|wmv|flv)$/i;
  if (allowedTypes.includes(mime)) {
    cb(null, true);
    return;
  }
  if (mime.startsWith('video/') || videoExt.test(name)) {
    cb(null, true);
    return;
  }
  cb(new Error('File type not supported'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB max (per-type limits enforced after upload)
  },
});

module.exports = upload;
