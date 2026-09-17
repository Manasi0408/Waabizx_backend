const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Message, Contact } = require('../models');
const socketService = require('../services/socketService');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB max (per-type limits enforced after upload)
  },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const ext = path.extname(name);
    const imageExt = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i;
    const videoExt = /\.(mp4|3gp|mov|avi|mkv|webm|m4v|mpeg|mpg|wmv|flv|ogv)$/i;
    const audioExt = /\.(mp3|wav|ogg|m4a|aac|amr|flac)$/i;
    const docExt = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i;
    if (
      mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      mime.startsWith('audio/') ||
      mime === 'application/pdf' ||
      imageExt.test(ext) ||
      videoExt.test(ext) ||
      audioExt.test(ext) ||
      docExt.test(ext)
    ) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Only images, documents, audio, and video files are allowed.'));
  }
});

// Upload media file
exports.uploadMedia = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId, mediaType } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const detectedMediaType = file.mimetype.startsWith('image/') ? 'image' :
                             file.mimetype.startsWith('video/') ? 'video' :
                             file.mimetype.startsWith('audio/') ? 'audio' :
                             'document';
    const maxBytes =
      detectedMediaType === 'video'
        ? 1024 * 1024 * 1024
        : detectedMediaType === 'document'
          ? 100 * 1024 * 1024
          : 16 * 1024 * 1024;
    if (file.size > maxBytes) {
      fs.unlinkSync(file.path);
      const limitLabel = detectedMediaType === 'video' ? '1 GB' : detectedMediaType === 'document' ? '100 MB' : '16 MB';
      return res.status(400).json({
        success: false,
        error: `${detectedMediaType} file is too large. Maximum size is ${limitLabel}.`,
      });
    }

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      // Delete uploaded file if contact not found
      fs.unlinkSync(file.path);
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Determine media type from file
    const resolvedMediaType = file.mimetype.startsWith('image/') ? 'image' :
                             file.mimetype.startsWith('video/') ? 'video' :
                             file.mimetype.startsWith('audio/') ? 'audio' :
                             'document';

    const mediaUrl = `/uploads/${file.filename}`;

    res.json({
      success: true,
      media: {
        url: mediaUrl,
        filename: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        mediaType: mediaType || resolvedMediaType
      }
    });
  } catch (error) {
    console.error('Error uploading media:', error);
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Send media message
exports.sendMediaMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId, mediaUrl, mediaType, mediaFilename, mediaSize, mediaMimeType, caption } = req.body;

    if (!contactId || !mediaUrl) {
      return res.status(400).json({
        success: false,
        error: 'Contact ID and media URL are required'
      });
    }

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Create message with media
    const message = await Message.create({
      contactId: contact.id,
      content: caption || '',
      type: 'outgoing',
      status: 'sent',
      mediaType: mediaType || 'image',
      mediaUrl,
      mediaFilename,
      mediaSize,
      mediaMimeType,
      sentAt: new Date()
    });

    // Emit to contact room
    socketService.emitToContact(contact.id, 'new-message', message);

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Error sending media message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Export upload middleware
// GET /api/media/whatsapp/:mediaId — download from Meta and return cached file
exports.getWhatsAppMedia = async (req, res) => {
  try {
    const userId = req.user.id;
    const { getProjectId } = require('../utils/projectScope');
    const projectId = getProjectId(req);
    const { mediaId } = req.params;
    if (!mediaId) {
      return res.status(400).json({ success: false, message: 'mediaId is required' });
    }

    const { downloadWhatsAppMedia, findCachedMediaUrl } = require('../services/metaMediaService');
    const path = require('path');
    const fs = require('fs');

    let publicUrl = findCachedMediaUrl(mediaId);
    if (!publicUrl) {
      publicUrl = await downloadWhatsAppMedia(mediaId, { userId, projectId });
    }
    if (!publicUrl) {
      return res.status(404).json({ success: false, message: 'Media not found or could not be downloaded' });
    }

    const absPath = path.join(__dirname, '..', publicUrl.replace(/^\//, ''));
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ success: false, message: 'Media file missing on disk' });
    }

    return res.sendFile(absPath);
  } catch (error) {
    console.error('getWhatsAppMedia:', error?.message || error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch media' });
  }
};

exports.upload = upload;

