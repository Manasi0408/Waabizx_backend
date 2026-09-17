const aisensyService = require('../services/aisensyService');
const axios = require('axios');
const { recordOutboundInboxMessage } = require('../services/outboundInboxService');
const { MetaMessage, Message, Contact, User, Template, sequelize } = require('../models');
const { Op, QueryTypes } = require('sequelize');
const { requireProjectId, getProjectId } = require('../utils/projectScope');
const { resolveWhatsAppSendCredentialCandidates, postWhatsAppMessage, formatMetaApiErrorMessage } = require('../utils/metaWhatsAppCredentials');
const { assertWhatsAppMessagingActive } = require('../utils/whatsappPayment');
const { buildClientTemplatePreview } = require('../utils/templatePreviewUtil');
const socketService = require('../services/socketService');

// Check WhatsApp API key connection
exports.checkApiKey = async (req, res) => {
  try {
    const result = await aisensyService.checkApiKeyConnection();
    
    if (result.connected) {
      res.status(200).json({
        success: true,
        ...result
      });
    } else {
      res.status(400).json({
        success: false,
        ...result
      });
    }
  } catch (err) {
    console.error('Check API Key Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to check API key connection'
    });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { phone, text, template, type, mediaUrl, mediaType } = req.body;

    // Phone is always required
    if (!phone) {
      return res.json({ 
        success: false, 
        error: 'Phone is required' 
      });
    }

    // Validation based on message type
    if (type === 'template') {
      // For template messages: template name and language code are required
      if (!template?.name || !template?.language?.code) {
        return res.json({ 
          success: false, 
          error: 'Template name and language required' 
        });
      }
    } else if (type === 'media' || mediaUrl) {
      // For media messages: mediaUrl is required
      if (!mediaUrl) {
        return res.json({ 
          success: false, 
          error: 'Media URL is required for media messages' 
        });
      }
    } else {
      // For text messages (or default): text is required
      if (!text && !mediaUrl) {
        return res.json({ 
          success: false, 
          error: 'Text or media URL is required' 
        });
      }
    }

    // Determine message text for database storage
    let messageText = text;
    let templateName = null;
    let templateSnapshot = null;
    const scopedProjectId = getProjectId(req);

    if (type === 'template' && template) {
      templateName = String(template.name || '').trim() || null;
      let templateRecord = null;
      if (templateName) {
        const templateWhere = { name: templateName };
        if (scopedProjectId) templateWhere.projectId = scopedProjectId;
        templateRecord = await Template.findOne({
          where: templateWhere,
          order: [['updatedAt', 'DESC']],
        });
      }
      templateSnapshot = buildClientTemplatePreview(
        templateRecord,
        templateRecord?.content || '',
        { templateName }
      );
      messageText = templateSnapshot?.body || templateRecord?.content || `Template: ${templateName || 'N/A'}`;
    }

    // Send message with all data (try to send to WhatsApp)
    let result = null;
    let sendStatus = 'sent';

    // Enforce opt-in/out before sending
    const requestingUserId = req.user?.id;
    const normalizedPhone = phone.toString().trim().replace(/^\+/, '');
    const contactWhere =
      requestingUserId && scopedProjectId
        ? { phone: normalizedPhone, userId: requestingUserId, projectId: scopedProjectId }
        : requestingUserId
        ? { phone: normalizedPhone, userId: requestingUserId }
        : { phone: normalizedPhone };
    const contact = await Contact.findOne({ where: contactWhere });
    const isOptedIn = !!(
      contact &&
      contact.status !== 'unsubscribed' &&
      contact.whatsappOptInAt
    );

    if (!isOptedIn) {
      console.log('❌ Blocked outbound message (opt-out / not opted-in):', normalizedPhone);
      sendStatus = 'failed';
    } else {
      try {
        const messagingGate = await assertWhatsAppMessagingActive(requestingUserId, scopedProjectId);
        if (!messagingGate.ok) {
          sendStatus = 'failed';
          return res.status(403).json({
            success: false,
            error: messagingGate.message,
            message: messagingGate.message,
            redirectUrl: messagingGate.redirectUrl || '/connect-whatsapp',
            paymentStatus: messagingGate.paymentStatus,
            accountStatus: messagingGate.accountStatus,
          });
        }

        const waCandidates = await resolveWhatsAppSendCredentialCandidates(requestingUserId, scopedProjectId);
        if (!waCandidates.length || !waCandidates[0]?.phoneNumberId || !waCandidates[0]?.accessToken) {
          sendStatus = 'failed';
          return res.json({
            success: false,
            error: 'WhatsApp API credentials not configured for this project.',
          });
        }

        const actualType = type || (mediaUrl ? 'media' : 'text');
        const to = normalizedPhone;
        let graphPayload;

        if (actualType === 'template' && template?.name) {
          graphPayload = {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.language?.code || 'en' },
              ...(Array.isArray(template.components) && template.components.length
                ? { components: template.components }
                : {}),
            },
          };
        } else if (actualType === 'media' || mediaUrl) {
          const mediaKind = String(mediaType || 'image').toLowerCase();
          graphPayload = {
            messaging_product: 'whatsapp',
            to,
            type: mediaKind,
            [mediaKind]: {
              link: mediaUrl,
              ...(text ? { caption: text } : {}),
            },
          };
        } else {
          graphPayload = {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: text || '' },
          };
        }

        const sent = await postWhatsAppMessage(waCandidates, graphPayload);
        result = sent.response?.data;
        console.log('✅ Meta Graph API send successful:', result);
      } catch (sendError) {
        console.error('❌ Error sending message via Meta Graph API:', sendError.message || sendError);
        sendStatus = 'failed';
        return res.json({
          success: false,
          error:
            sendError.metaMessage ||
            formatMetaApiErrorMessage(sendError) ||
            sendError.message ||
            'Failed to send WhatsApp message',
        });
      }
    }

    const waMessageId = result?.messages?.[0]?.id || null;

    // Save to MetaMessage table (always save, even if WhatsApp send failed)
    await MetaMessage.create({
      phone,
      direction: 'outbound',
      message_type: type || 'text',
      message_text: messageText || '',
      status: sendStatus,
      projectId: getProjectId(req) || null
    });

    // Also save to Message table so it appears in inbox
    // Use the authenticated user from req.user (if available)
    const userId = req.user?.id;
    
    if (userId) {
      const projectId = scopedProjectId;
      let contact = projectId
        ? await Contact.findOne({ where: { phone, userId, projectId } })
        : await Contact.findOne({ where: { phone, userId } });

      if (!contact) {
        contact = await Contact.create({
          userId: userId,
          projectId: projectId || null,
          phone,
          name: phone,
          status: 'active'
        });
        console.log('✅ Created new contact (ID:', contact.id + ')');
      } else {
        console.log('✅ Contact found (ID:', contact.id + ')');
      }

      // Save message to Message table for inbox (templates live in inboxmessages with full snapshot)
      if (type !== 'template') {
        await Message.create({
          contactId: contact.id,
          content: messageText || '',
          type: 'outgoing',
          status: sendStatus,
          sentAt: new Date()
        });
      }

      // Update contact's lastContacted
      await contact.update({
        lastContacted: new Date()
      });

      const savedInbox = await recordOutboundInboxMessage(contact.phone, messageText || '', {
        status: sendStatus === 'failed' ? 'failed' : 'sent',
        projectId: contact.projectId || projectId || null,
        isTemplateSend: type === 'template' && sendStatus !== 'failed',
        templateName,
        templateSnapshot,
        waMessageId,
      });

      if (savedInbox && sendStatus !== 'failed' && userId) {
        try {
          socketService.emitToContact(contact.id, 'new-message', {
            id: savedInbox.id,
            contactId: contact.id,
            phone: contact.phone,
            content: messageText || '',
            type: 'outgoing',
            status: savedInbox.status,
            sentAt: savedInbox.timestamp ? savedInbox.timestamp.toISOString() : new Date().toISOString(),
            waMessageId,
            isTemplate: type === 'template',
            templateName,
            templatePreview: templateSnapshot,
          });
          socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
        } catch (socketErr) {
          console.error('Socket emit after meta send:', socketErr?.message || socketErr);
        }
      }
    } else {
      // Fallback: If no authenticated user, try to find first active user (for backward compatibility)
      const firstUser = await User.findOne({
        where: { status: 'active' },
        order: [['id', 'ASC']]
      });

      if (firstUser) {
        // Find or create contact - phone has unique constraint, so find by phone first
        let contact = await Contact.findOne({
          where: { phone }
        });

        if (!contact) {
          // Contact doesn't exist, create new one
          contact = await Contact.create({
            userId: firstUser.id,
            phone,
            name: phone,
            status: 'active'
          });
          console.log('✅ Created new contact (ID:', contact.id + ')');
        } else {
          // Contact exists - update userId if different
          if (contact.userId !== firstUser.id) {
            await contact.update({ userId: firstUser.id });
            console.log('✅ Updated contact userId (ID:', contact.id + ')');
          } else {
            console.log('✅ Contact found (ID:', contact.id + ')');
          }
        }

        // Save message to Message table for inbox (templates live in inboxmessages with full snapshot)
        if (type !== 'template') {
          await Message.create({
            contactId: contact.id,
            content: messageText || '',
            type: 'outgoing',
            status: sendStatus,
            sentAt: new Date()
          });
        }

        // Update contact's lastContacted
        await contact.update({
          lastContacted: new Date()
        });

        await recordOutboundInboxMessage(contact.phone, messageText || '', {
          status: sendStatus === 'failed' ? 'failed' : 'sent',
          projectId: getProjectId(req) || contact.projectId || null,
          isTemplateSend: type === 'template' && sendStatus !== 'failed',
          templateName,
          templateSnapshot,
          waMessageId,
        });
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Send Message Error:', err);
    res.json({ 
      success: false, 
      error: err.response?.data?.message || err.message || 'Unknown error'
    });
  }
};

// Get inbound messages (for external systems to retrieve)
exports.getInboundMessages = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { limit = 10, phone, since, status } = req.query;

    const rawLimit = parseInt(limit, 10);
    const safeLimit =
      Number.isFinite(rawLimit) && rawLimit >= 1000 ? 5000 : Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1), 5000);

    const replacements = { projectId };
    let extraSql = '';
    if (phone) {
      replacements.phone = String(phone).trim();
      extraSql += ' AND mm.phone = :phone';
    }
    if (status) {
      replacements.status = String(status).trim();
      extraSql += ' AND mm.status = :status';
    }
    if (since) {
      replacements.since = new Date(since);
      extraSql += ' AND mm.created_at >= :since';
    }

    const messages = await sequelize.query(
      `
      SELECT mm.id, mm.phone, mm.direction, mm.message_type, mm.message_text, mm.status, mm.created_at
      FROM meta_messages mm
      WHERE mm.direction = 'inbound'
        AND mm.projectId = :projectId
        ${extraSql}
      ORDER BY mm.created_at DESC
      LIMIT ${safeLimit}
      `,
      { replacements, type: QueryTypes.SELECT }
    );

    res.json({
      success: true,
      count: messages.length,
      messages: messages.map((msg) => ({
        id: msg.id,
        phone: msg.phone,
        direction: msg.direction,
        message_type: msg.message_type,
        text: msg.message_text,
        status: msg.status,
        received_at: msg.created_at
      }))
    });
  } catch (err) {
    console.error('Get Inbound Messages Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get inbound messages'
    });
  }
};

// Get all meta messages (inbound + outbound) by phone
exports.getAllMetaMessages = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { phone, limit = 100, since, direction } = req.query;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    // Build where clause
    const where = {
      phone: phone,
      projectId,
    };

    // Filter by direction if provided
    if (direction) {
      where.direction = direction;
    }

    // Filter by date if provided (messages after this date)
    if (since) {
      where.created_at = {
        [Op.gte]: new Date(since)
      };
    }

    // Get all messages for this phone
    // Use a very high limit or no limit if limit is very high
    const queryLimit = parseInt(limit) >= 10000 ? null : parseInt(limit);
    const messages = await MetaMessage.findAll({
      where,
      limit: queryLimit, // null means no limit
      order: [['created_at', 'ASC']], // Oldest first for chat view
      attributes: [
        'id',
        'phone',
        'direction',
        'message_type',
        'message_text',
        'status',
        'created_at',
        'reactions'
      ]
    });

    res.json({
      success: true,
      count: messages.length,
      messages: messages.map(msg => ({
        id: msg.id,
        phone: msg.phone,
        direction: msg.direction,
        message_type: msg.message_type,
        text: msg.message_text,
        status: msg.status,
        created_at: msg.created_at,
        reactions: msg.reactions || null
      }))
    });
  } catch (err) {
    console.error('Get All Meta Messages Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get meta messages'
    });
  }
};

// Get message status by ID
exports.getMessageStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Message ID is required'
      });
    }

    // Try to find message by ID (could be database ID or external ID from AiSensy)
    // First try as database ID
    let message = await MetaMessage.findByPk(id);

    // If not found, try searching by any external ID field if it exists
    // For now, we'll check if it's a UUID format and search accordingly
    if (!message) {
      // If ID is UUID format, it might be from AiSensy API response
      // Check if we stored it somewhere or need to query AiSensy API
      message = await MetaMessage.findOne({
        where: {
          // Add any field that might store external ID
          // For now, return not found
        }
      });
    }

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
        id: id
      });
    }

    res.json({
      success: true,
      message: {
        id: message.id,
        phone: message.phone,
        direction: message.direction,
        message_type: message.message_type,
        status: message.status,
        message_text: message.message_text,
        created_at: message.created_at
      }
    });
  } catch (err) {
    console.error('Get Message Status Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get message status'
    });
  }
};
