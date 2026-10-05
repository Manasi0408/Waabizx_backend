const { Op } = require('sequelize');
const db = require('../config/db');
const Project = require('../models/Project');
const { Contact, Message, InboxMessage, User, CampaignAudience, Campaign, ClientWhatsApp } = require('../models');
const { phoneVariantsForLookup } = require('../utils/phoneNormalize');
const {
  buildInboxRecordFromWebhook,
  buildSocketMessagePayload,
  normalizeWebhookMessage,
} = require('../utils/waMessageNormalizer');
const { extractInboundPreviewText } = require('../utils/inboundMessageParser');
const { downloadWhatsAppMedia, extractMediaIdFromPayload } = require('./metaMediaService');
const { syncInboundToConversation } = require('./conversationInboxService');
const socketService = require('./socketService');
const {
  resolveProjectFromWebhookPhone,
  extractInboundPhoneNumberId,
  resolveInboundFlowProjectId,
} = require('../utils/projectWhatsAppPhoneSync');

async function resolveDefaultProjectId() {
  try {
    const [rows] = await db.query(`SELECT id FROM projects ORDER BY id ASC LIMIT 1`);
    if (Array.isArray(rows) && rows.length > 0 && rows[0].id != null) return Number(rows[0].id);
  } catch (e) {}
  return 1;
}

async function resolveProjectByCustomerPhone(customerPhone) {
  if (!customerPhone) return null;
  const variants = phoneVariantsForLookup(customerPhone);
  if (variants.length === 0) return null;

  try {
    const contact = await Contact.findOne({
      where: { phone: { [Op.in]: variants }, projectId: { [Op.ne]: null } },
      attributes: ['projectId'],
      order: [['updatedAt', 'DESC']],
    });
    if (contact?.projectId != null) return Number(contact.projectId);
  } catch (e) {}

  try {
    const audience = await CampaignAudience.findOne({
      where: { phone: { [Op.in]: variants } },
      include: [{ model: Campaign, attributes: ['projectId'], required: true }],
      order: [['updatedAt', 'DESC']],
    });
    if (audience?.Campaign?.projectId != null) {
      return Number(audience.Campaign.projectId);
    }
  } catch (e) {}

  try {
    const [convRows] = await db.query(
      `SELECT project_id FROM conversations
       WHERE phone IN (?) AND project_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [variants]
    );
    if (Array.isArray(convRows) && convRows.length > 0 && convRows[0].project_id != null) {
      return Number(convRows[0].project_id);
    }
  } catch (e) {}

  try {
    const mapping = await ClientWhatsApp.findOne({
      where: { phone: { [Op.in]: variants } },
      attributes: ['project_id'],
      order: [['id', 'DESC']],
    });
    if (mapping?.project_id != null) return Number(mapping.project_id);
  } catch (e) {}

  return null;
}

async function findContactByPhoneVariants(fromNumber, projectId) {
  const variants = phoneVariantsForLookup(fromNumber);
  if (!variants.length) return null;

  const baseQuery = {
    where: { phone: { [Op.in]: variants } },
    order: [['updatedAt', 'DESC']],
    attributes: [
      'id',
      'phone',
      'name',
      'email',
      'status',
      'tags',
      'country',
      'lastContacted',
      'notes',
      'userId',
      'projectId',
      'whatsappOptInAt',
      'customFields',
      'createdAt',
      'updatedAt',
    ],
  };

  if (projectId) {
    const scoped = await Contact.findOne({
      ...baseQuery,
      where: { phone: { [Op.in]: variants }, projectId },
    });
    if (scoped) return scoped;
  }

  return Contact.findOne(baseQuery);
}

async function isInboundPersisted(waMessageId) {
  const id = String(waMessageId || '').trim();
  if (!id) return false;
  const count = await InboxMessage.count({ where: { waMessageId: id } });
  return count > 0;
}

async function resolveInboundContactUserId(projectId, preferredUserId = null) {
  const preferred = Number(preferredUserId);
  if (Number.isInteger(preferred) && preferred > 0) {
    const user = await User.findOne({
      where: { id: preferred, status: 'active' },
      attributes: ['id'],
    });
    if (user?.id) return Number(user.id);
  }

  const pid = Number(projectId);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      const ownerId = await Project.getProjectOwnerId(pid);
      if (ownerId) {
        const owner = await User.findOne({
          where: { id: ownerId, status: 'active' },
          attributes: ['id'],
        });
        if (owner?.id) return Number(owner.id);
      }
    } catch (_) {
      /* non-fatal */
    }

    const assigned = await User.findOne({
      where: { status: 'active', projectId: pid },
      order: [['id', 'ASC']],
      attributes: ['id'],
    });
    if (assigned?.id) return Number(assigned.id);
  }

  const fallback = await User.findOne({
    where: { status: 'active' },
    order: [['id', 'ASC']],
    attributes: ['id'],
  });
  return fallback?.id ? Number(fallback.id) : null;
}

async function resolveInboundProjectId(payload, valueEntry, phone) {
  const phoneNumberId = extractInboundPhoneNumberId(payload, valueEntry);
  const wabaId = payload?.entry?.[0]?.id || payload?.waba_id || payload?.wabaId || null;

  let projectId = null;
  const mapped = await resolveProjectFromWebhookPhone({ phoneNumberId, wabaId });
  if (mapped?.projectId) projectId = mapped.projectId;

  if (!projectId) {
    projectId = await resolveInboundFlowProjectId({
      phoneNumberId,
      wabaId,
      fallbackProjectId: null,
    });
  }

  if (!projectId && phone) {
    projectId = await resolveProjectByCustomerPhone(phone);
  }

  if (!projectId) {
    projectId = await resolveDefaultProjectId();
  }

  return projectId;
}

/**
 * Idempotently persist an inbound customer message to Message + InboxMessage.
 * Safe to call when webhook dedup skipped flow handling or when the other webhook won the claim.
 */
async function persistInboundCustomerMessage({
  messageObj,
  phone,
  text,
  projectId,
  timestamp,
  waMessageId,
  userId: preferredUserId,
}) {
  if (!phone) return { skipped: true, reason: 'no_phone' };

  const ts = timestamp || new Date();
  const resolvedProjectId = projectId || (await resolveDefaultProjectId());
  const inboundWaMessageId =
    waMessageId || messageObj?.id || messageObj?.message_id || null;

  if (await isInboundPersisted(inboundWaMessageId)) {
    return { skipped: true, reason: 'already_persisted' };
  }

  let contact = await findContactByPhoneVariants(phone, resolvedProjectId);
  if (!contact) {
    const ownerUserId = await resolveInboundContactUserId(resolvedProjectId, preferredUserId);
    if (!ownerUserId) return { skipped: true, reason: 'no_user' };

    contact = await Contact.create({
      userId: ownerUserId,
      projectId: resolvedProjectId,
      phone,
      name: phone,
      status: 'active',
      whatsappOptInAt: new Date(),
    });
  } else if (resolvedProjectId && !contact.projectId) {
    await contact.update({ projectId: resolvedProjectId });
    contact.projectId = resolvedProjectId;
  }

  const userId = contact.userId;
  const previewText =
    extractInboundPreviewText(messageObj) || String(text || '').trim() || '';

  const newMessage = await Message.create({
    contactId: contact.id,
    content: previewText,
    type: 'incoming',
    status: 'delivered',
    sentAt: ts,
    deliveredAt: ts,
  });

  const inboxData = buildInboxRecordFromWebhook(
    messageObj || { type: 'text', text: { body: previewText } },
    contact,
    userId,
    contact.projectId || resolvedProjectId,
    ts,
    previewText
  );
  if (inboundWaMessageId && !inboxData.waMessageId) {
    inboxData.waMessageId = inboundWaMessageId;
  }
  const inboxMessage = await InboxMessage.create(inboxData);

  const mediaId = extractMediaIdFromPayload(messageObj);
  if (mediaId && inboxMessage?.id) {
    const inboxId = inboxMessage.id;
    const cacheProjectId = contact.projectId || resolvedProjectId || null;
    setImmediate(() => {
      downloadWhatsAppMedia(mediaId, { userId, projectId: cacheProjectId })
        .then((url) => {
          if (url) {
            return InboxMessage.update({ mediaUrl: url }, { where: { id: inboxId } });
          }
          return null;
        })
        .catch((err) => console.warn('[inbound-persist] media cache failed:', err?.message || err));
    });
  }

  await contact.update({ lastContacted: ts, lastCustomerMessageAt: ts });

  let conversationId = null;
  try {
    const synced = await syncInboundToConversation({
      phone,
      text,
      projectId: contact.projectId || resolvedProjectId,
      customerName: contact.name || phone,
      createdAt: ts,
    });
    conversationId = synced.conversationId;
  } catch (syncErr) {
    console.error('[inbound-persist] syncInboundToConversation failed:', syncErr?.message || syncErr);
  }

  const normalizedInbound = normalizeWebhookMessage(messageObj || { type: 'text', text: { body: previewText } }, {
    direction: 'inbound',
    status: 'delivered',
    timestamp: ts,
    from: phone,
    waMessageId: inboundWaMessageId,
  });
  const socketPayload = buildSocketMessagePayload(normalizedInbound, {
    id: inboxMessage?.id || newMessage.id,
    contactId: contact.id,
    conversationId,
    phone,
    content: previewText,
    sentAt: ts instanceof Date ? ts.toISOString() : ts,
    createdAt: newMessage.createdAt ? newMessage.createdAt.toISOString() : new Date().toISOString(),
  });
  socketPayload.conversation_id = conversationId;
  socketPayload.message = previewText;

  socketService.emitToManager('new-message', socketPayload);
  socketService.emitToManager('inbox-update', {
    contactId: contact.id,
    phone,
    lastMessage: previewText,
    lastMessageTime: ts,
  });
  if (contact.userId) {
    socketService.emitToUser(contact.userId, 'inbox-update', { contactId: contact.id });
  }

  return {
    skipped: false,
    contact,
    message: newMessage,
    inboxMessage,
    conversationId,
  };
}

module.exports = {
  isInboundPersisted,
  persistInboundCustomerMessage,
  resolveInboundProjectId,
  resolveInboundContactUserId,
};
