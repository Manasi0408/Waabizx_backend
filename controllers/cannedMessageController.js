const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Op } = require('sequelize');
const { requireProjectId } = require('../utils/projectScope');

const { CannedMessage, User } = require('../models');

// Configure multer for image/file uploads (stored under backend/uploads).
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    // Allow image uploads for IMAGE type, and allow any upload for FILE type.
    // We rely on the size limit above to keep the server safe.
    const mimetype = file.mimetype || '';
    if (mimetype.startsWith('image/')) return cb(null, true);
    return cb(null, true);
  },
});

const normalizeType = (t) => String(t || '').trim().toUpperCase();

exports.getCannedMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const search = String(req.query.search || '').trim();

    const where = { userId, projectId };
    if (search) {
      where[Op.or] = [{ name: { [Op.like]: `%${search}%` } }];
    }

    const messages = await CannedMessage.findAll({
      where,
      include: [
        {
          model: User,
          attributes: ['name', 'email'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    const formatted = messages.map((m) => {
      const createdBy = m.User?.name || m.User?.email || '';
      const type = m.messageType;
      const text =
        type === 'TEXT'
          ? m.text || ''
          : m.mediaFilename || m.mediaUrl || '';

      return {
        id: m.id,
        name: m.name,
        type,
        text,
        mediaUrl: m.mediaUrl,
        createdBy,
        isFavorite: !!m.isFavorite,
      };
    });

    res.json({ success: true, messages: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.createCannedMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { name } = req.body;
    const messageType = normalizeType(req.body.messageType);
    const text = req.body.text;

    if (!name || !messageType) {
      return res.status(400).json({ success: false, message: 'Name and messageType are required' });
    }

    if (!['TEXT', 'IMAGE', 'FILE'].includes(messageType)) {
      return res.status(400).json({ success: false, message: 'Invalid messageType' });
    }

    let mediaUrl = null;
    let mediaFilename = null;

    if (messageType === 'IMAGE' || messageType === 'FILE') {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: messageType === 'IMAGE' ? 'Please upload an image file' : 'Please upload a file',
        });
      }
      mediaUrl = `/uploads/${req.file.filename}`;
      mediaFilename = req.file.originalname;
    } else {
      // TEXT
      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, message: 'Text is required for TEXT messages' });
      }
    }

    const created = await CannedMessage.create({
      userId,
      projectId,
      name: String(name).trim(),
      messageType,
      text: messageType === 'TEXT' ? String(text) : null,
      mediaUrl,
      mediaFilename,
      isFavorite: false,
    });

    res.status(201).json({ success: true, message: created });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.updateCannedMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const messageId = Number(req.params.id);
    const { name } = req.body;
    const messageType = req.body.messageType ? normalizeType(req.body.messageType) : null;
    const text = req.body.text;

    const msg = await CannedMessage.findOne({ where: { id: messageId, userId, projectId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Canned message not found' });

    let mediaUrl = msg.mediaUrl;
    let mediaFilename = msg.mediaFilename;

    if (messageType && !['TEXT', 'IMAGE', 'FILE'].includes(messageType)) {
      return res.status(400).json({ success: false, message: 'Invalid messageType' });
    }

    // If message type changes and requires file/text, validate accordingly.
    const finalType = messageType || msg.messageType;

    if (finalType === 'TEXT') {
      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, message: 'Text is required for TEXT messages' });
      }
      msg.text = String(text);
      msg.mediaUrl = null;
      msg.mediaFilename = null;
    } else {
      // IMAGE / FILE
      if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        mediaFilename = req.file.originalname;
      } else if (!msg.mediaUrl) {
        return res.status(400).json({ success: false, message: 'Please upload a file for IMAGE/FILE messages' });
      }
      msg.text = null;
      msg.mediaUrl = mediaUrl;
      msg.mediaFilename = mediaFilename;
    }

    if (name) msg.name = String(name).trim();
    if (finalType) msg.messageType = finalType;

    await msg.save();
    res.json({ success: true, message: msg });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.deleteCannedMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const messageId = Number(req.params.id);

    const msg = await CannedMessage.findOne({ where: { id: messageId, userId, projectId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Canned message not found' });

    // Best-effort cleanup of uploaded file.
    if (msg.mediaUrl) {
      try {
        const filename = msg.mediaUrl.split('/').pop();
        const uploadPath = path.join(__dirname, '../uploads', filename);
        if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
      } catch (_) {
        // ignore cleanup errors
      }
    }

    await msg.destroy();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.toggleFavorite = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const messageId = Number(req.params.id);
    const { isFavorite } = req.body;

    const msg = await CannedMessage.findOne({ where: { id: messageId, userId, projectId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Canned message not found' });

    if (typeof isFavorite === 'boolean') {
      msg.isFavorite = isFavorite;
    } else {
      msg.isFavorite = !msg.isFavorite;
    }

    await msg.save();
    res.json({ success: true, isFavorite: !!msg.isFavorite });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

module.exports = {
  upload,
  getCannedMessages: exports.getCannedMessages,
  createCannedMessage: exports.createCannedMessage,
  updateCannedMessage: exports.updateCannedMessage,
  deleteCannedMessage: exports.deleteCannedMessage,
  toggleFavorite: exports.toggleFavorite,
};

