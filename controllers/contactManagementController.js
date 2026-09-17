const { Contact, Message } = require('../models');
const { Op } = require('sequelize');
const socketService = require('../services/socketService');

// Update contact info
exports.updateContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { name, email, notes, tags, avatar } = req.body;

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (notes !== undefined) updateData.notes = notes;
    if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : [];
    if (avatar !== undefined) updateData.avatar = avatar;

    await contact.update(updateData);

    // Emit update to user
    socketService.emitToUser(userId, 'contact-updated', contact);

    res.json({
      success: true,
      contact
    });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get contact history
exports.getContactHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;
    const { limit = 100 } = req.query;

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Get message history
    const messages = await Message.findAll({
      where: {
        contactId: contact.id,
        isDeleted: false
      },
      limit: parseInt(limit),
      order: [['sentAt', 'DESC']],
      attributes: ['id', 'content', 'type', 'status', 'sentAt', 'mediaType', 'mediaUrl']
    });

    // Get contact activity summary
    const stats = {
      totalMessages: await Message.count({
        where: { contactId: contact.id, isDeleted: false }
      }),
      sentMessages: await Message.count({
        where: { contactId: contact.id, type: 'outgoing', isDeleted: false }
      }),
      receivedMessages: await Message.count({
        where: { contactId: contact.id, type: 'incoming', isDeleted: false }
      }),
      firstContact: await Message.findOne({
        where: { contactId: contact.id },
        order: [['sentAt', 'ASC']],
        attributes: ['sentAt']
      })
    };

    res.json({
      success: true,
      contact,
      messages,
      stats
    });
  } catch (error) {
    console.error('Error fetching contact history:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update typing status
exports.updateTypingStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId, isTyping } = req.body;

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    await contact.update({ isTyping });

    // Emit typing status
    socketService.emitToContact(contactId, 'typing', {
      contactId,
      isTyping,
      userId
    });

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error updating typing status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update online status
exports.updateOnlineStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId, isOnline } = req.body;

    const contact = await Contact.findOne({
      where: { id: contactId, userId }
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    await contact.update({
      isOnline,
      lastSeen: isOnline ? new Date() : new Date()
    });

    // Emit online status
    socketService.emitToContact(contactId, 'online-status', {
      contactId,
      isOnline,
      lastSeen: contact.lastSeen
    });

    res.json({
      success: true,
      contact
    });
  } catch (error) {
    console.error('Error updating online status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

