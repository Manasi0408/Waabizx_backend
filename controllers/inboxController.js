const Project = require('../models/Project');
const { Contact, Message, MetaMessage, InboxMessage, Template, sequelize, Campaign, CampaignAudience } = require('../models');
const { Op } = require('sequelize');
const socketService = require('../services/socketService');
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('../services/wccMetaChargeService');
const { requireProjectId } = require('../utils/projectScope');
const {
  resolveWhatsAppSendCredentialCandidates,
  postWhatsAppMessage,
  formatMetaApiErrorMessage,
  resolveWhatsAppApiHttpStatus,
  isUnverifiedWabaError,
  isSessionWindowClosedError,
} = require('../utils/metaWhatsAppCredentials');
const { assertWhatsAppMessagingActive } = require('../utils/whatsappPayment');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');
const { ensureProjectMessagingCredentials } = require('../services/newProjectWhatsAppService');
const { logWhatsAppSend } = require('../utils/directApiLogger');
const {
  sendReengagementTemplateMessage,
  resolveReengagementTemplate,
} = require('../services/inboxReengagementSendService');
const { resolveTemplateBillingCategory } = require('../utils/messageCategoryPricing');
const {
  buildClientTemplatePreview,
  parseTemplateSnapshot,
  enrichPreviewHeader,
  isTemplateMarkerContent,
  mergeTemplatePreviewWithCatalog,
  buildTemplateCatalogMap,
} = require('../utils/templatePreviewUtil');
const { dedupeInboxMessages } = require('../utils/mergeInboxMessages');
const {
  enrichInboxMessageForClient,
  extractTemplateNameFromBody,
} = require('../utils/inboxMessageApiUtil');
const {
  downloadWhatsAppMedia,
  extractMediaIdFromPayload,
} = require('../services/metaMediaService');

const isAgentRole = (r) => (r || '').toString().toLowerCase() === 'agent';
const isProjectWideInboxRole = (r) => ['agent', 'admin', 'manager', 'super_admin'].includes((r || '').toString().toLowerCase());
const phoneVariants = (phone) => {
  const raw = String(phone || '').trim();
  if (!raw) return [];
  const digits = raw.replace(/^\+/, '').replace(/\D/g, '');
  const set = new Set([raw, digits, `+${digits}`]);
  if (digits.length === 10) {
    set.add(`91${digits}`);
    set.add(`+91${digits}`);
  }
  if (digits.startsWith('91') && digits.length === 12) {
    set.add(digits.slice(2));
    set.add(`+${digits.slice(2)}`);
  }
  return [...set].filter(Boolean);
};

// Get inbox chat list - one row per contact with last message and unread count
// Includes contacts from Message table AND meta_messages table
// For agents (e.g. /campaign-reports history): return all contacts so they see same as admin inbox
exports.getInboxList = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const role = (req.user.role || '').toString().toLowerCase();
    const agentSeesAll = isProjectWideInboxRole(role);
    const contactTableName = Contact.tableName;
    const messageTableName = Message.tableName;
    const metaMessageTableName = MetaMessage.tableName;
    const inboxMessageTableName = InboxMessage.tableName;

    const userFilter = agentSeesAll ? '' : 'AND c.userId = :userId';
    const replacements = agentSeesAll ? { projectId } : { userId, projectId };

    const mmScoped = (alias) => `${alias}.projectId = :projectId`;

    const inboxList = await sequelize.query(`
      SELECT DISTINCT
        c.id as contactId,
        c.phone,
        COALESCE(
          NULLIF(
            CASE
              WHEN c.name IS NOT NULL
                AND TRIM(c.name) <> ''
                AND REPLACE(REPLACE(REPLACE(TRIM(c.name), '+', ''), ' ', ''), '-', '')
                  <> REPLACE(REPLACE(REPLACE(TRIM(c.phone), '+', ''), ' ', ''), '-', '')
              THEN TRIM(c.name)
              ELSE NULL
            END,
            NULL
          ),
          (
            SELECT NULLIF(TRIM(conv.customer_name), '')
            FROM conversations conv
            WHERE REPLACE(REPLACE(REPLACE(TRIM(conv.phone), '+', ''), ' ', ''), '-', '')
                = REPLACE(REPLACE(REPLACE(TRIM(c.phone), '+', ''), ' ', ''), '-', '')
              AND conv.project_id = :projectId
              AND conv.customer_name IS NOT NULL
              AND TRIM(conv.customer_name) <> ''
              AND REPLACE(REPLACE(REPLACE(TRIM(conv.customer_name), '+', ''), ' ', ''), '-', '')
                <> REPLACE(REPLACE(REPLACE(TRIM(c.phone), '+', ''), ' ', ''), '-', '')
            ORDER BY CASE WHEN conv.project_id <=> :projectId THEN 0 ELSE 1 END ASC,
                     conv.last_message_time DESC
            LIMIT 1
          ),
          NULLIF(TRIM(c.name), ''),
          c.phone
        ) as name,
        c.email,
        c.status as contactStatus,
        c.lastContacted,
        c.whatsappOptInAt,
        COALESCE(
          (SELECT
            COALESCE(
              NULLIF(JSON_UNQUOTE(JSON_EXTRACT(im.templateSnapshot, '$.body')), ''),
              CASE
                WHEN im.message REGEXP '^(Template:|\\\\[Template\\\\])' THEN NULL
                ELSE im.message
              END
            )
           FROM \`${inboxMessageTableName}\` im
           WHERE im.contactId = c.id
             AND im.projectId = :projectId
           ORDER BY im.timestamp DESC
           LIMIT 1),
          (SELECT m.content
           FROM \`${messageTableName}\` m
           WHERE m.contactId = c.id
             AND m.content NOT REGEXP '^(Template:|\\\\[Template\\\\])'
           ORDER BY m.sentAt DESC
           LIMIT 1),
          (SELECT mm.message_text
           FROM \`${metaMessageTableName}\` mm
           WHERE mm.phone = c.phone
             AND ${mmScoped('mm')}
           ORDER BY mm.created_at DESC
           LIMIT 1),
          ''
        ) as lastMessage,
        COALESCE(
          (SELECT im.timestamp
           FROM \`${inboxMessageTableName}\` im
           WHERE im.contactId = c.id
             AND im.projectId = :projectId
           ORDER BY im.timestamp DESC
           LIMIT 1),
          (SELECT m.sentAt
           FROM \`${messageTableName}\` m
           WHERE m.contactId = c.id
           ORDER BY m.sentAt DESC
           LIMIT 1),
          (SELECT mm.created_at
           FROM \`${metaMessageTableName}\` mm
           WHERE mm.phone = c.phone
             AND ${mmScoped('mm')}
           ORDER BY mm.created_at DESC
           LIMIT 1)
        ) as lastMessageTime,
        (
          SELECT COUNT(*) 
          FROM \`${messageTableName}\` m 
          WHERE m.contactId = c.id 
            AND m.type = 'incoming' 
            AND m.status != 'read'
        ) + (
          SELECT COUNT(*)
          FROM \`${inboxMessageTableName}\` im
          WHERE im.contactId = c.id
            AND im.projectId = :projectId
            AND im.direction = 'incoming'
            AND im.status != 'read'
        ) as unreadCount,
        (
          SELECT conv.status
          FROM conversations conv
          WHERE conv.phone = c.phone
            AND conv.status != 'closed'
            AND conv.project_id = :projectId
          ORDER BY CASE WHEN conv.project_id <=> :projectId THEN 0 ELSE 1 END ASC, conv.id DESC
          LIMIT 1
        ) as chatStatus,
        (
          SELECT conv.id
          FROM conversations conv
          WHERE conv.phone = c.phone
            AND conv.status != 'closed'
            AND conv.project_id = :projectId
          ORDER BY CASE WHEN conv.project_id <=> :projectId THEN 0 ELSE 1 END ASC, conv.id DESC
          LIMIT 1
        ) as conversationId,
        (
          EXISTS (
            SELECT 1 FROM \`${messageTableName}\` m_in
            WHERE m_in.contactId = c.id
              AND m_in.type = 'incoming'
          )
          OR EXISTS (
            SELECT 1 FROM \`${inboxMessageTableName}\` im_in
            WHERE im_in.contactId = c.id
              AND im_in.projectId = :projectId
              AND im_in.direction = 'incoming'
          )
        ) as hasCustomerReply
      FROM \`${contactTableName}\` c
      WHERE 1=1 ${userFilter}
        AND (
          c.projectId = :projectId
          OR EXISTS (
            SELECT 1
            FROM \`${inboxMessageTableName}\` im_scope
            WHERE im_scope.contactId = c.id
              AND im_scope.projectId = :projectId
          )
        )
        AND (
          EXISTS (
            SELECT 1 
            FROM \`${messageTableName}\` m 
            WHERE m.contactId = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM \`${inboxMessageTableName}\` im
            WHERE im.contactId = c.id
              AND im.projectId = :projectId
          )
          OR EXISTS (
            SELECT 1 
            FROM \`${metaMessageTableName}\` mm 
            WHERE mm.phone = c.phone
              AND ${mmScoped('mm')}
          )
        )
      ORDER BY lastMessageTime DESC
    `, {
      replacements,
      type: sequelize.QueryTypes.SELECT
    });

    const metaMessagesContacts = await sequelize.query(`
      SELECT DISTINCT
        NULL as contactId,
        mm.phone,
        mm.phone as name,
        NULL as email,
        'active' as contactStatus,
        MAX(mm.created_at) as lastContacted,
        NULL as whatsappOptInAt,
        (SELECT mm2.message_text 
         FROM \`${metaMessageTableName}\` mm2 
         WHERE mm2.phone = mm.phone 
           AND ${mmScoped('mm2')}
         ORDER BY mm2.created_at DESC 
         LIMIT 1) as lastMessage,
        MAX(mm.created_at) as lastMessageTime,
        0 as unreadCount,
        (
          SELECT conv.status
          FROM conversations conv
          WHERE conv.phone = mm.phone
            AND conv.status != 'closed'
            AND conv.project_id = :projectId
          ORDER BY CASE WHEN conv.project_id <=> :projectId THEN 0 ELSE 1 END ASC, conv.id DESC
          LIMIT 1
        ) as chatStatus,
        (
          SELECT conv.id
          FROM conversations conv
          WHERE conv.phone = mm.phone
            AND conv.status != 'closed'
            AND conv.project_id = :projectId
          ORDER BY CASE WHEN conv.project_id <=> :projectId THEN 0 ELSE 1 END ASC, conv.id DESC
          LIMIT 1
        ) as conversationId
      FROM \`${metaMessageTableName}\` mm
      ${agentSeesAll ? 'WHERE EXISTS (SELECT 1 FROM `' + contactTableName + '` c2 WHERE c2.phone = mm.phone AND c2.projectId = :projectId) AND (' + mmScoped('mm') + ')' : 'WHERE NOT EXISTS (SELECT 1 FROM `' + contactTableName + '` c2 WHERE c2.phone = mm.phone AND c2.userId = :userId AND c2.projectId = :projectId) AND EXISTS (SELECT 1 FROM `' + contactTableName + '` c3 WHERE c3.phone = mm.phone AND c3.projectId = :projectId) AND (' + mmScoped('mm') + ')'}
      GROUP BY mm.phone
      ORDER BY lastMessageTime DESC
    `, {
      replacements,
      type: sequelize.QueryTypes.SELECT
    });

    // Combine both lists
    const allContacts = [...inboxList, ...metaMessagesContacts];

    // Format the response
    const formattedList = allContacts.map(item => ({
      contactId: item.contactId,
      phone: item.phone,
      name: item.name || item.phone,
      email: item.email,
      status: item.contactStatus,
      lastContacted: item.lastContacted,
      whatsappOptInAt: item.whatsappOptInAt || null,
      lastMessage: item.lastMessage || '',
      lastMessageTime: item.lastMessageTime,
      unreadCount: parseInt(item.unreadCount) || 0,
      chatStatus: item.chatStatus || null,
      conversationId: item.conversationId != null ? Number(item.conversationId) : null,
    }));

    // Remove duplicates by phone (keep the one with contactId if available)
    const uniqueContacts = [];
    const seenPhones = new Set();
    for (const contact of formattedList) {
      if (!seenPhones.has(contact.phone)) {
        seenPhones.add(contact.phone);
        uniqueContacts.push(contact);
      }
    }

    // Sort by lastMessageTime
    uniqueContacts.sort((a, b) => {
      const timeA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const timeB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return timeB - timeA;
    });

    const markerContacts = uniqueContacts.filter((c) => isTemplateMarkerContent(c.lastMessage));
    if (markerContacts.length > 0) {
      const ownerId = await Project.getProjectOwnerId(projectId);
      const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
      const templateRows = await Template.findAll({
        where: { projectId, userId: { [Op.in]: userIds } },
        limit: 500,
      });
      const templateByName = await buildTemplateCatalogMap(templateRows, { userId, projectId });

      uniqueContacts.forEach((contact) => {
        if (!isTemplateMarkerContent(contact.lastMessage)) return;
        const name = extractTemplateNameFromBody(contact.lastMessage);
        const tpl = name ? templateByName.get(String(name).toLowerCase()) : null;
        if (!tpl) return;
        const preview = buildClientTemplatePreview(tpl, tpl.content || '', { templateName: name });
        if (preview?.body) contact.lastMessage = preview.body;
      });
    }

    res.json({
      success: true,
      inbox: uniqueContacts
    });
  } catch (error) {
    console.error('Error fetching inbox list:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Get messages of a specific contact by phone
exports.getContactMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const role = (req.user.role || '').toString().toLowerCase();
    const agentSeesAll = isProjectWideInboxRole(role);
    // Decode phone number - handle both encoded and non-encoded formats
    let phone = req.params.phone;
    try {
      phone = decodeURIComponent(phone);
    } catch (e) {
      phone = req.params.phone;
    }
    phone = phone.replace(/%2B/g, '+');
    const variants = phoneVariants(phone);
    const normalizedPhone = variants[0] || phone;

    let contactWhere = agentSeesAll
      ? { phone: { [Op.in]: variants }, projectId }
      : { phone: { [Op.in]: variants }, userId, projectId };
    let contact = await Contact.findOne({ where: contactWhere });

    // Fallback: contact may have null/old projectId while messages are correctly project-scoped.
    if (!contact) {
      contactWhere = agentSeesAll ? { phone: { [Op.in]: variants } } : { phone: { [Op.in]: variants }, userId };
      contact = await Contact.findOne({ where: contactWhere });
      if (contact) {
        const hasProjectScopedInboxMessages = await InboxMessage.count({
          where: {
            contactId: contact.id,
            projectId
          }
        });
        if (!hasProjectScopedInboxMessages) {
          contact = null;
        }
      }
    }

    if (!contact) {
      // Project may have only meta/webhook rows initially (no Contact yet).
      // Return synthetic contact so frontend can continue loading meta messages without 404.
      const hasScopedMetaMessages = await MetaMessage.count({
        where: {
          phone: { [Op.in]: variants },
          projectId,
        },
      });
      if (hasScopedMetaMessages > 0) {
        return res.json({
          success: true,
          contact: {
            id: null,
            phone: normalizedPhone,
            name: normalizedPhone,
            email: null,
            status: 'active',
            whatsappOptInAt: null
          },
          messages: []
        });
      }
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    const messageWhere = { contactId: contact.id };
    if (Number(contact.projectId) === Number(projectId)) {
      messageWhere[Op.or] = [{ projectId }, { projectId: null }];
    } else {
      messageWhere.projectId = projectId;
    }

    // Get all messages for this contact from Message table
    const messages = await Message.findAll({
      where: messageWhere,
      order: [['sentAt', 'ASC']],
      attributes: [
        'id',
        'content',
        'status',
        'type',
        'sentAt',
        'deliveredAt',
        'readAt',
        'createdAt',
        'updatedAt'
      ]
    });

    const inboxMessageWhere = agentSeesAll
      ? { contactId: contact.id, projectId }
      : { contactId: contact.id, userId, projectId };

    const inboxAttrsFull = [
      'id', 'message', 'status', 'direction', 'type', 'timestamp', 'waMessageId',
      'isTemplateSend', 'templateName', 'templateSnapshot', 'payload', 'mediaUrl', 'createdAt', 'updatedAt',
    ];
    const inboxAttrsBase = [
      'id', 'message', 'status', 'direction', 'type', 'timestamp', 'waMessageId',
      'isTemplateSend', 'createdAt', 'updatedAt',
    ];

    let inboxMessages;
    try {
      inboxMessages = await InboxMessage.findAll({
        where: inboxMessageWhere,
        order: [['timestamp', 'ASC']],
        attributes: inboxAttrsFull,
      });
    } catch (colErr) {
      console.warn('InboxMessage full attributes query failed, using base columns:', colErr?.message);
      inboxMessages = await InboxMessage.findAll({
        where: inboxMessageWhere,
        order: [['timestamp', 'ASC']],
        attributes: inboxAttrsBase,
      });
    }

    const convertedMessages = messages
      .filter((m) => {
        const plain = m.get ? m.get({ plain: true }) : { ...m };
        return !isTemplateMarkerContent(String(plain.content || '').trim());
      })
      .map((m) => {
      const plain = m.get ? m.get({ plain: true }) : { ...m };
      const body = String(plain.content || '').trim();
      return {
        id: `msg_${plain.id}`,
        content: body,
        status: plain.status,
        type: plain.type,
        sentAt: plain.sentAt,
        deliveredAt: plain.deliveredAt,
        readAt: plain.readAt,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
        source: 'message',
        isTemplate: body.startsWith('Template:'),
        templateName: body.startsWith('Template:') ? body.replace(/^Template:\s*/i, '').trim() : null,
      };
    });

    const templateNamesNeeded = new Set();
    inboxMessages.forEach((im) => {
      const body = String(im.message || '').trim();
      const name = im.templateName || extractTemplateNameFromBody(body);
      if (name && (im.isTemplateSend || isTemplateMarkerContent(body))) {
        templateNamesNeeded.add(name);
      }
    });

    const hasTemplateSends = inboxMessages.some(
      (im) =>
        im.isTemplateSend ||
        isTemplateMarkerContent(String(im.message || '').trim())
    );
    let templateByName = new Map();
    if (templateNamesNeeded.size > 0 || hasTemplateSends) {
      const ownerId = await Project.getProjectOwnerId(projectId);
      const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
      const templateRows = await Template.findAll({
        where: { projectId, userId: { [Op.in]: userIds } },
        limit: 500,
      });
      templateByName = await buildTemplateCatalogMap(templateRows, { userId, projectId });
    }

    let convertedInboxMessages = await Promise.all(
      inboxMessages.map((im) =>
        enrichInboxMessageForClient(im, { projectId, userId, templateByName })
      )
    );

    // Merge and deduplicate — never drop template metadata from inboxmessages
    const allMessages = dedupeInboxMessages([...convertedMessages, ...convertedInboxMessages]);

    res.json({
      success: true,
      contact: {
        id: contact.id,
        phone: contact.phone,
        name: contact.name,
        email: contact.email,
        status: contact.status,
        whatsappOptInAt: contact.whatsappOptInAt || null
      },
      messages: allMessages
    });
  } catch (error) {
    console.error('Error fetching contact messages:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Send message from inbox
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { phone, message: text } = req.body; // Accept both 'phone' and 'to', 'message' and 'text'

    // Support multiple field names for compatibility
    const to = phone || req.body.to || req.body.phone;
    const messageText = text || req.body.message || req.body.text;

    if (!to || !messageText) {
      return res.status(400).json({
        success: false,
        message: 'Phone and message are required'
      });
    }

    const planInfo = await Project.getPlanInfo(projectId);
    if (!planInfo?.active) {
      return res.status(403).json({
        success: false,
        message: 'Your plan has ended. Recharge now to send messages.',
        planExpired: true,
      });
    }

    // Normalize for WhatsApp API (accepts +, spaces, 10-digit local, etc.)
    const normalizedPhone = normalizeWhatsAppRecipient(to) ||
      to.toString().trim().replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
    const variants = phoneVariants(normalizedPhone);

    // 1️⃣ Ensure contact exists - phone has unique constraint, so find by phone first
    // Then update userId if different (contact might exist for different user)
    let contact = await Contact.findOne({
      where: { phone: { [Op.in]: variants }, projectId }
    });

    // Legacy: one row per (userId, phone) with projectId unset — attach to this project once.
    if (!contact) {
      contact = await Contact.findOne({
        where: { phone: { [Op.in]: variants }, userId, projectId: null }
      });
      if (contact) {
        await contact.update({ projectId });
        await contact.reload();
        console.log('✅ Migrated legacy contact to project (ID:', contact.id + ')');
      }
    }

    if (!contact) {
      try {
        contact = await Contact.create({
          userId: userId,
          projectId,
          phone: normalizedPhone,
          name: normalizedPhone,
          status: 'active',
          whatsappOptInAt: new Date()
        });
        console.log('✅ Created new contact (ID:', contact.id + ')');
      } catch (createErr) {
        // Race-safe fallback for duplicate create attempts.
        if (createErr?.name === 'SequelizeUniqueConstraintError' || /Validation error/i.test(createErr?.message || '')) {
          contact = await Contact.findOne({
            where: { phone: { [Op.in]: variants }, projectId }
          });
        }
        if (!contact) throw createErr;
      }
    } else {
      console.log('✅ Contact found (ID:', contact.id + ')');
    }

    // Enforce opt-in/out before sending
    const isOptedIn =
      contact.status !== 'unsubscribed' &&
      !!contact.whatsappOptInAt;

    if (!isOptedIn) {
      const message = await Message.create({
        contactId: contact.id,
        projectId,
        content: messageText,
        type: 'outgoing',
        status: 'failed',
        errorMessage: 'Blocked (opt-out / not opted-in)',
        sentAt: new Date()
      });

      // Also save to InboxMessage so UI shows the attempt
      let inboxMessage = null;
      try {
        inboxMessage = await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: 'outgoing',
          message: messageText,
          type: 'text',
          status: 'failed',
          timestamp: new Date()
        });
      } catch (inboxError) {
        console.error('Error saving blocked InboxMessage:', inboxError);
      }

      await contact.update({
        lastContacted: new Date()
      });

      // Emit socket events for real-time UI
      try {
        const messageData = {
          id: inboxMessage?.id || message.id,
          contactId: contact.id,
          phone: normalizedPhone,
          content: messageText,
          type: 'outgoing',
          status: message.status,
          sentAt: message.sentAt ? message.sentAt.toISOString() : new Date().toISOString(),
          createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
          waMessageId: inboxMessage?.waMessageId || null
        };
        socketService.emitToContact(contact.id, 'new-message', messageData);
        socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
      } catch (socketError) {
        console.error('Error emitting socket (blocked message):', socketError);
      }

      return res.status(403).json({
        success: false,
        message: 'Blocked (opt-out / not opted-in)',
        error: 'Blocked (opt-out / not opted-in)',
        messageRecord: {
          id: message.id,
          content: message.content,
          status: message.status,
          type: message.type,
          errorMessage: 'Blocked (opt-out / not opted-in)',
        },
      });
    }

    const recordFailedOutboundAttempt = async (errorMessage) => {
      const failedMessage = await Message.create({
        contactId: contact.id,
        projectId,
        content: messageText,
        type: 'outgoing',
        status: 'failed',
        errorMessage: errorMessage || 'Failed',
        sentAt: new Date(),
      });
      let failedInbox = null;
      try {
        failedInbox = await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: 'outgoing',
          message: messageText,
          type: 'text',
          status: 'failed',
          timestamp: new Date(),
        });
      } catch (inboxError) {
        console.error('Error saving failed InboxMessage:', inboxError);
      }
      return { message: failedMessage, inboxMessage: failedInbox };
    };

    // Send via WhatsApp first — persist to DB after Meta accepts the message.
    let sendResult = null;
    let apiError = null;
    let sentViaTemplate = false;
    let templateNameUsed = null;
    let templateSnapshot = null;

    try {
      const prep = await ensureProjectMessagingCredentials(userId, projectId);
      if (prep?.bootstrap && !prep.ok && prep.bootstrap?.requiresWhatsAppConnect) {
        const gateMessage =
          prep.bootstrap.message ||
          'WhatsApp is not connected for this project. Open Connect WhatsApp to continue.';
        const { message, inboxMessage } = await recordFailedOutboundAttempt(gateMessage);
        return res.status(403).json({
          success: false,
          message: gateMessage,
          error: gateMessage,
          redirectUrl: '/connect-whatsapp?autoConnect=1',
        });
      }

      const messagingGate = await assertWhatsAppMessagingActive(userId, projectId);
      if (!messagingGate.ok) {
        const gateMessage =
          messagingGate.message || 'WhatsApp messaging is not active for this project.';
        const { message, inboxMessage } = await recordFailedOutboundAttempt(gateMessage);
        return res.status(403).json({
          success: false,
          message: gateMessage,
          error: gateMessage,
          redirectUrl: messagingGate.redirectUrl || '/connect-whatsapp',
        });
      }

      // Conversation billing/quota enforcement (24-hour rolling).
      let billing = { allowed: true, wasNew: false };
      try {
        billing = await upsertConversationWithQuota(userId, normalizedPhone);
      } catch (billingErr) {
        console.error('Conversation billing check failed (inboxController.sendMessage):', billingErr?.message || billingErr);
      }

      if (!billing.allowed) {
        const errorMessage = 'Blocked (conversation limit reached)';
        const { message, inboxMessage } = await recordFailedOutboundAttempt(errorMessage);

        await contact.update({ lastContacted: new Date() });

        try {
          const messageData = {
            id: inboxMessage?.id || message.id,
            contactId: contact.id,
            phone: normalizedPhone,
            content: messageText,
            type: 'outgoing',
            status: 'failed',
            sentAt: message.sentAt ? message.sentAt.toISOString() : new Date().toISOString(),
            createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
            waMessageId: null,
          };
          socketService.emitToContact(contact.id, 'new-message', messageData);
          socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
        } catch (socketError) {
          console.error('Error emitting socket (blocked by quota):', socketError);
        }

        return res.status(403).json({
          success: false,
          message: errorMessage,
          error: errorMessage,
          messageRecord: {
            id: message.id,
            content: message.content,
            status: 'failed',
            type: message.type,
            errorMessage,
          },
        });
      }

      const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
      if (!waCandidates.length) {
        throw new Error(
          'No WhatsApp credentials for this project. Connect WhatsApp from Connect WhatsApp page.'
        );
      }

      const wccCheck = await requireWccForOutgoing(projectId, billing, {
        isTemplate: false,
        customerPhone: normalizedPhone,
      }).catch((wccErr) => {
        console.error('WCC check failed (inboxController.sendMessage):', wccErr?.message || wccErr);
        return { ok: true, ownerUserId: null, charge: 0, balance: 0, skipped: true };
      });
      if (!wccCheck.ok) {
        const errorMessage = 'Blocked (insufficient WCC balance)';
        const { message, inboxMessage } = await recordFailedOutboundAttempt(errorMessage);
        await contact.update({ lastContacted: new Date() });
        try {
          const messageData = {
            id: inboxMessage?.id || message.id,
            contactId: contact.id,
            phone: normalizedPhone,
            content: messageText,
            type: 'outgoing',
            status: 'failed',
            sentAt: message.sentAt ? message.sentAt.toISOString() : new Date().toISOString(),
            createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
            waMessageId: null,
          };
          socketService.emitToContact(contact.id, 'new-message', messageData);
          socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
        } catch (socketError) {
          console.error('Error emitting socket (blocked by WCC):', socketError);
        }
        return res.status(403).json({
          success: false,
          message: errorMessage,
          error: errorMessage,
          messageRecord: {
            id: message.id,
            content: message.content,
            status: 'failed',
            type: message.type,
            errorMessage,
          },
        });
      }

      const textPayload = {
        messaging_product: 'whatsapp',
        to: normalizedPhone,
        type: 'text',
        text: { body: messageText },
      };

      const directBase = require('../services/aisensyDirectApiClient').getPrimaryDirectApiBase();
      const directPath = require('../services/aisensyDirectApiClient').getDirectApiSendPath(false);
      const inboxUseDirectApi =
        String(process.env.INBOX_SEND_VIA_DIRECT_API ?? 'true').trim().toLowerCase() !== 'false';

      logWhatsAppSend(
        'INBOX_SEND_START',
        {
          source: 'POST /api/inbox/send',
          api: inboxUseDirectApi
            ? `AiSensy Direct API → ${directBase}${directPath}`
            : `Meta Graph API → https://graph.facebook.com/${apiVersion}/${phoneId}/messages`,
          projectId,
          userId,
          phone: normalizedPhone,
          contactId: contact.id,
        },
        textPayload,
        { status: 'pending' }
      );

      try {
        const sent = await postWhatsAppMessage(waCandidates, textPayload, {
          userId,
          projectId,
          preferDirectApi: inboxUseDirectApi,
          graphOnly: false,
        });
        const wamid = sent.response?.data?.messages?.[0]?.id || null;
        if (!wamid) {
          throw new Error(
            formatMetaApiErrorMessage({ response: { data: sent.response?.data } }) ||
              'WhatsApp API did not return a message id'
          );
        }
        sendResult = {
          success: true,
          messageId: wamid,
          wamid,
          response: sent.response?.data,
        };
        logWhatsAppSend(
          'INBOX_SEND_OK',
          {
            source: 'POST /api/inbox/send',
            api: inboxUseDirectApi ? 'AiSensy Direct API' : 'Meta Graph API',
            credentialSource: sent.creds?.source,
            waMessageId: wamid,
          },
          textPayload,
          sent.response?.data
        );
      } catch (textErr) {
        if (!isSessionWindowClosedError(textErr)) throw textErr;
        console.log('📨 Text send blocked by Meta session window — retrying as template');
        let reengTemplateRecord = await resolveReengagementTemplate({ userId, projectId });
        if (!reengTemplateRecord) {
          reengTemplateRecord = { category: 'utility', metaCategory: 'UTILITY' };
        }
        const templateBillingCategory = resolveTemplateBillingCategory({
          category: reengTemplateRecord.category,
          metaCategory: reengTemplateRecord.metaCategory,
          variables: reengTemplateRecord.variables,
        });
        const templateWccCheck = await requireWccForOutgoing(projectId, billing, {
          isTemplate: true,
          customerPhone: normalizedPhone,
          billingCategory: templateBillingCategory,
          userId,
        }).catch((wccErr) => {
          console.error('WCC template check failed (inboxController.sendMessage):', wccErr?.message || wccErr);
          return { ok: false, balance: 0, charge: 0, ownerUserId: null };
        });
        const templateWccBalance =
          templateWccCheck.balance ??
          (await Project.getWccCredits(projectId, templateWccCheck.ownerUserId || userId));
        if (!templateWccCheck.ok || templateWccBalance <= 0) {
          const errorMessage = 'Recharge for WCC to send template message.';
          const { message, inboxMessage } = await recordFailedOutboundAttempt(errorMessage);
          await contact.update({ lastContacted: new Date() });
          try {
            const messageData = {
              id: inboxMessage?.id || message.id,
              contactId: contact.id,
              phone: normalizedPhone,
              content: messageText,
              type: 'outgoing',
              status: 'failed',
              sentAt: message.sentAt ? message.sentAt.toISOString() : new Date().toISOString(),
              createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
              waMessageId: null,
            };
            socketService.emitToContact(contact.id, 'new-message', messageData);
            socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
          } catch (socketError) {
            console.error('Error emitting socket (blocked template by WCC):', socketError);
          }
          return res.status(403).json({
            success: false,
            message: errorMessage,
            error: errorMessage,
            messageRecord: {
              id: message.id,
              content: message.content,
              status: 'failed',
              type: message.type,
              errorMessage,
            },
          });
        }
        try {
          const reeng = await sendReengagementTemplateMessage({
            userId,
            projectId,
            phone: normalizedPhone,
            messageText,
            waCandidates,
          });
          sentViaTemplate = true;
          templateNameUsed = reeng.templateName;
          templateSnapshot = reeng.snapshotForInbox;
          sendResult = {
            success: true,
            messageId: reeng.wamid,
            wamid: reeng.wamid,
            response: reeng.response,
          };
          logWhatsAppSend(
            'INBOX_SEND_TEMPLATE_OK',
            {
              source: 'POST /api/inbox/send',
              api: inboxUseDirectApi ? 'AiSensy Direct API (template)' : 'Meta Graph API (template)',
              template: reeng.templateName,
              waMessageId: reeng.wamid,
            },
            { templateName: reeng.templateName, messageText },
            reeng.response
          );
        } catch (templateErr) {
          const friendly =
            'This contact has not messaged you in the last 24 hours. WhatsApp only allows free text inside that window. Ask them to reply first, or use an approved template from Meta Business Manager → Message templates.';
          templateErr.metaMessage = friendly;
          templateErr.message = friendly;
          throw templateErr;
        }
      }

      if (sendResult && sendResult.success) {
        const wamid = sendResult.wamid || sendResult.messageId;
        const sentViaTemplateCopy = sentViaTemplate;
        const templateNameUsedCopy = templateNameUsed;
        const templateSnapshotCopy = templateSnapshot;
        const outboundContent = sentViaTemplateCopy
          ? (templateSnapshotCopy?.body || messageText)
          : messageText;

        res.json({
          success: true,
          sentViaTemplate: sentViaTemplateCopy,
          templateName: templateNameUsedCopy || undefined,
          message: {
            id: null,
            content: outboundContent,
            status: 'sent',
            type: 'text',
            sentAt: new Date(),
            contactId: contact.id,
            waMessageId: wamid,
            messageType: sentViaTemplateCopy ? 'template' : 'text',
            isTemplateSend: sentViaTemplateCopy,
            templateName: templateNameUsedCopy || undefined,
          },
        });

        setImmediate(() => {
          (async () => {
            try {
              const message = await Message.create({
                contactId: contact.id,
                projectId,
                content: outboundContent,
                type: 'outgoing',
                status: 'sent',
                sentAt: new Date(),
              });

              const inboxPayload = {
                contactId: contact.id,
                userId,
                projectId,
                direction: 'outgoing',
                message: outboundContent,
                type: 'text',
                status: 'sent',
                waMessageId: wamid,
                timestamp: new Date(),
              };
              if (sentViaTemplateCopy) {
                inboxPayload.isTemplateSend = true;
                inboxPayload.templateName = templateNameUsedCopy;
                inboxPayload.templateSnapshot = templateSnapshotCopy
                  ? JSON.stringify(templateSnapshotCopy)
                  : null;
                inboxPayload.mediaUrl =
                  templateSnapshotCopy?.headerImageUrl || templateSnapshotCopy?.header?.url || null;
              }

              const inboxMessage = await InboxMessage.create(inboxPayload);

              await debitWccAfterSuccessfulMetaSend(projectId, wccCheck.ownerUserId, billing, {
                isTemplate: sentViaTemplateCopy,
                customerPhone: normalizedPhone,
                inboxMessageId: inboxMessage?.id,
                waMessageId: wamid,
              });

              await contact.update({ lastContacted: new Date() });

              const messageData = {
                id: inboxMessage?.id || message.id,
                contactId: contact.id,
                phone: normalizedPhone,
                content: outboundContent,
                type: 'outgoing',
                status: 'sent',
                sentAt: message.sentAt ? message.sentAt.toISOString() : new Date().toISOString(),
                createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
                waMessageId: wamid,
                messageType: sentViaTemplateCopy ? 'template' : 'text',
                isTemplateSend: sentViaTemplateCopy,
                templateName: templateNameUsedCopy || undefined,
              };
              socketService.emitToContact(contact.id, 'new-message', messageData);
              socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
            } catch (postSendErr) {
              console.error('Post-send inbox persistence failed (message already sent):', postSendErr?.message || postSendErr);
            }
          })();
        });
        return;
      }
    } catch (sendError) {
      apiError = sendError;
      console.error('❌ Error sending message via Meta API:', sendError.message || sendError);
      
      // Update message status to failed
      const errorMessage =
        sendError.metaMessage ||
        formatMetaApiErrorMessage(sendError) ||
        sendError.message ||
        'Failed to send via Meta API';
      setImmediate(() => {
        recordFailedOutboundAttempt(errorMessage).catch((updateErr) => {
          console.error('Failed to save failed outbound attempt:', updateErr?.message || updateErr);
        });
      });
    }

    if (apiError) {
      const friendlyError =
        formatMetaApiErrorMessage(apiError) ||
        apiError.metaMessage ||
        apiError.message ||
        'Failed to send via Meta API';
      const httpStatus = resolveWhatsAppApiHttpStatus(apiError, 422);
      return res.status(httpStatus).json({
        success: false,
        message: friendlyError,
        error: friendlyError,
        wabaUnverified: isUnverifiedWabaError(apiError),
        redirectUrl: isUnverifiedWabaError(apiError) ? '/connect-whatsapp' : undefined,
        messageRecord: {
          content: messageText,
          status: 'failed',
          type: 'text',
          errorMessage: friendlyError,
        },
      });
    }
  } catch (error) {
    console.error('Error sending message:', error);
    const isDbError = /access denied|ECONNREFUSED|ER_|Sequelize/i.test(String(error?.message || ''));
    res.status(isDbError ? 503 : 500).json({
      success: false,
      message: isDbError
        ? 'Database is unavailable. Check server DB credentials and try again.'
        : (error.message || 'Server error'),
      error: error.message || 'Server error'
    });
  }
};

// Mark messages as read for a contact
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const role = (req.user.role || '').toString().toLowerCase();
    const projectWide = isProjectWideInboxRole(role);
    // Decode phone number - handle both encoded and non-encoded formats
    let phone = req.params.phone;
    try {
      // Try decoding (in case it's encoded)
      phone = decodeURIComponent(phone);
    } catch (e) {
      // If decoding fails, use as-is
      phone = req.params.phone;
    }
    // Also handle %2B which is encoded +
    phone = phone.replace(/%2B/g, '+');

    const variants = phoneVariants(phone);
    let contacts = await Contact.findAll({
      where: {
        phone: { [Op.in]: variants },
        ...(projectWide ? {} : { userId }),
        projectId,
      },
    });

    if (!contacts.length) {
      const legacy = await Contact.findAll({
        where: {
          phone: { [Op.in]: variants },
          ...(projectWide ? {} : { userId }),
          projectId: null,
        },
      });
      for (const row of legacy) {
        await row.update({ projectId });
      }
      contacts = legacy;
    }

    if (!contacts.length) {
      return res.json({
        success: true,
        message: 'No contact record — nothing to mark read',
        updatedCount: 0,
      });
    }
    const contactIds = contacts.map((c) => c.id);

    // Update all incoming Message rows that are not read
    const [updatedMessageCount] = await Message.update(
      {
        status: 'read',
        readAt: new Date()
      },
      {
        where: {
          contactId: { [Op.in]: contactIds },
          type: 'incoming',
          status: {
            [Op.ne]: 'read'
          }
        }
      }
    );

    // Update all incoming InboxMessage rows that are not read
    const [updatedInboxMessageCount] = await InboxMessage.update(
      {
        status: 'read'
      },
      {
        where: {
          contactId: { [Op.in]: contactIds },
          projectId,
          direction: 'incoming',
          status: {
            [Op.ne]: 'read'
          }
        }
      }
    );

    const updatedCount = (Number(updatedMessageCount) || 0) + (Number(updatedInboxMessageCount) || 0);

    res.json({
      success: true,
      message: `Marked ${updatedCount} messages as read`,
      updatedCount
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Campaigns that included this contact phone (agent Chat Profile)
exports.getContactCampaigns = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const phone = decodeURIComponent(String(req.params.phone || '').trim());
    const variants = phoneVariants(phone);
    if (!variants.length) {
      return res.json({ success: true, campaigns: [] });
    }

    const rows = await CampaignAudience.findAll({
      where: { phone: { [Op.in]: variants } },
      include: [
        {
          model: Campaign,
          required: true,
          where: { projectId },
          attributes: ['id', 'name', 'status', 'template_name', 'createdAt'],
        },
      ],
      order: [['updatedAt', 'DESC']],
      limit: 50,
    });

    const campaigns = (rows || []).map((row) => {
      const plain = row.get ? row.get({ plain: true }) : row;
      const camp = plain.Campaign || plain.campaign || {};
      return {
        id: camp.id,
        name: camp.name || camp.template_name || `Campaign ${camp.id || plain.campaignId}`,
        status: plain.status || camp.status || 'pending',
        campaignStatus: camp.status || null,
        sentAt: plain.sentAt || null,
        deliveredAt: plain.deliveredAt || null,
        readAt: plain.readAt || null,
      };
    });

    return res.json({ success: true, campaigns });
  } catch (error) {
    console.error('Error fetching contact campaigns:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

// Payment / order rows for this contact (empty until commerce orders exist)
exports.getContactPayments = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    // Placeholder for WhatsApp commerce / payment messages linked to contact
    return res.json({ success: true, payments: [] });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

