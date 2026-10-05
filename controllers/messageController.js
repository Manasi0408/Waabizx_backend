const axios = require('axios');
const { Message, Contact, User, InboxMessage, Template, MetaMessage } = require('../models');
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
  postWhatsAppTemplateMessage,
  formatMetaApiErrorMessage,
  resolveWhatsAppApiHttpStatus,
  isUnverifiedWabaError,
} = require('../utils/metaWhatsAppCredentials');
const { normalizeWhatsAppRecipient, phoneVariantsForLookup } = require('../utils/phoneNormalize');
const { assertWhatsAppMessagingActive } = require('../utils/whatsappPayment');
const Project = require('../models/Project');
const db = require('../config/db');
const { resolveTemplateBillingCategory } = require('../utils/messageCategoryPricing');
const {
  normalizeMetaTemplateName,
  resolveTemplateComponentsForSend,
  loadTemplateRecordForCampaign,
  fetchMetaTemplateByName,
} = require('../services/metaTemplateFetchService');
const {
  getTemplateComponents,
  extractButtonsFromComponents,
  parseTemplateSendSpec,
  buildWhatsAppTemplateComponents,
  buildWhatsAppCarouselTemplateComponents,
  extractDynamicUrlButtonComponents,
  resolveDisplayableHeaderMediaUrl,
  resolveHeaderImageFromComponents,
  toPublicMediaUrl,
  toPermanentUploadPath,
} = require('../utils/templateMessageComponents');
const {
  buildClientTemplatePreview,
  finalizeTemplateSnapshotForInbox,
  enrichTemplateRecordWithComponents,
  isTemplateMarkerContent,
  resolveHeaderFromCampaign,
} = require('../utils/templatePreviewUtil');
const { syncOutboundToConversation } = require('../services/conversationInboxService');
const { resolveHeaderMediaIdForSend } = require('../services/templateHeaderSendService');

function buildTemplatePreviewForInbox(templateRecord, templateContent, metaTemplateName, paramsArray = [], headerMediaUrl = null) {
  return buildClientTemplatePreview(templateRecord, templateContent, {
    templateName: metaTemplateName,
    templateParams: paramsArray,
    headerImageUrl: headerMediaUrl,
  });
}

async function saveFailedTemplateInboxRow({
  contact,
  userId,
  projectId,
  templateRecord,
  templateContent,
  metaTemplateName,
  paramsArray = [],
  headerMediaUrl = null,
}) {
  const clientPreview = buildTemplatePreviewForInbox(
    templateRecord,
    templateContent,
    metaTemplateName,
    paramsArray,
    headerMediaUrl
  );
  await InboxMessage.create({
    contactId: contact.id,
    userId,
    projectId,
    direction: 'outgoing',
    message: clientPreview?.body || templateContent,
    type: 'text',
    status: 'failed',
    isTemplateSend: true,
    templateName: metaTemplateName,
    templateSnapshot: clientPreview ? JSON.stringify(clientPreview) : null,
    timestamp: new Date(),
  });
}

const normalizePhone = (value) => String(value || '').trim().replace(/\D/g, '');

/** Match Contact.phone when Meta stores 10-digit or 91-prefixed (same as inbox contact matching). */
const digitsOnlyPhoneVariants = (digits) => {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return [];
  const set = new Set([d]);
  const noLeadingZeros = d.replace(/^0+/, '') || d;
  if (noLeadingZeros !== d) set.add(noLeadingZeros);
  const core = noLeadingZeros;
  if (core.length === 10) set.add(`91${core}`);
  if (core.startsWith('91') && core.length === 12) set.add(core.slice(2));
  return [...set];
};

/** Inbox uses `123` (messages table) or `meta_456` (meta_messages). */
function parseInboxMessageRef(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('meta_')) {
    const id = parseInt(s.slice(5), 10);
    return Number.isInteger(id) && id > 0 ? { kind: 'meta', id } : null;
  }
  const id = parseInt(s, 10);
  return Number.isInteger(id) && id > 0 ? { kind: 'message', id } : null;
}
const extractTemplateVariableNumbers = (content = '') => {
  const matches = String(content).match(/\{\{(\d+)\}\}/g) || [];
  return Array.from(
    new Set(
      matches
        .map((m) => parseInt(m.replace(/[{}]/g, ''), 10))
        .filter((n) => Number.isFinite(n))
    )
  ).sort((a, b) => a - b);
};

async function findContactForProjectSend({ phoneVariants, normalizedPhone, projectId, userId }) {
  let contact = await Contact.findOne({
    where: { userId, phone: { [Op.in]: phoneVariants }, projectId },
  });

  if (!contact) {
    contact = await Contact.findOne({
      where: { userId, phone: { [Op.in]: phoneVariants }, projectId: null },
    });
  }

  if (!contact) {
    contact = await Contact.findOne({
      where: { userId, phone: { [Op.in]: phoneVariants } },
      order: [['updatedAt', 'DESC']],
    });
  }

  if (!contact) {
    try {
      contact = await Contact.create({
        userId,
        projectId: null,
        phone: normalizedPhone,
        name: normalizedPhone,
        status: 'active',
        whatsappOptInAt: new Date(),
      });
    } catch (createErr) {
      if (createErr?.name === 'SequelizeUniqueConstraintError') {
        contact = await Contact.findOne({
          where: { userId, phone: { [Op.in]: phoneVariants } },
          order: [['updatedAt', 'DESC']],
        });
      }
      if (!contact) throw createErr;
    }
  }

  return contact;
}

async function ensureContactOptInForActiveChat(contact, normalizedPhone, projectId) {
  if (!contact || contact.status === 'unsubscribed' || contact.whatsappOptInAt) {
    return contact;
  }

  try {
    const variants = digitsOnlyPhoneVariants(normalizedPhone);
    if (!variants.length) return contact;

    const placeholders = variants.map(() => '?').join(',');
    const [convRows] = await db.query(
      `SELECT 1 AS ok FROM conversations c
       WHERE c.project_id = ?
         AND REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', '') IN (${placeholders})
       LIMIT 1`,
      [projectId, ...variants]
    );

    const [inboxRows] = await db.query(
      `SELECT 1 AS ok FROM inboxmessages im
       WHERE im.contactId = ? AND im.direction = 'incoming'
       LIMIT 1`,
      [contact.id]
    );

    if ((convRows && convRows.length > 0) || (inboxRows && inboxRows.length > 0)) {
      await contact.update({ status: 'active', whatsappOptInAt: new Date() });
      await contact.reload();
    }
  } catch (e) {
    console.warn('ensureContactOptInForActiveChat:', e?.message || e);
  }

  return contact;
}

async function loadApprovedTemplateForSend({ templateName, userId, projectId }) {
  const ownerId = await Project.getProjectOwnerId(projectId);
  const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
  const normalizedName = normalizeMetaTemplateName(templateName);
  const nameVariants = [...new Set([templateName, normalizedName].filter(Boolean))];

  let record = await Template.findOne({
    where: {
      projectId,
      userId: { [Op.in]: userIds },
      name: { [Op.in]: nameVariants },
      [Op.or]: [{ status: 'approved' }, { metaStatus: 'APPROVED' }],
    },
  });

  if (!record) {
    record = await loadTemplateRecordForCampaign({
      userId: ownerId || userId,
      projectId,
      templateName,
    });
  }

  return record;
}

// Send message via Meta API
exports.sendMessage = async (req, res) => {
  try {
    // Get userId from authenticated user (middleware sets req.user)
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    
    // Log incoming payload for debugging
    console.log('📥 Inbox payload received:', JSON.stringify(req.body, null, 2));
    
    // Accept multiple field name formats (phone, to, contact.phone) and (message, text, content)
    let phone = req.body.phone || req.body.to || req.body.contact?.phone;
    let message = req.body.message || req.body.text || req.body.content;

    // Validate input with detailed error messages
    if (!phone) {
      console.error('❌ Missing phone number in payload:', req.body);
      return res.status(400).json({ 
        success: false, 
        msg: "Missing required field: phone (or 'to' or 'contact.phone')",
        receivedPayload: req.body
      });
    }

    if (!message) {
      console.error('❌ Missing message content in payload:', req.body);
      return res.status(400).json({ 
        success: false, 
        msg: "Missing required field: message (or 'text' or 'content')",
        receivedPayload: req.body
      });
    }

    // Normalize phone number format (ensure it has country code)
    phone = normalizeWhatsAppRecipient(phone);
    
    // If phone doesn't start with country code, log warning but still try
    if (!phone.match(/^\d{10,15}$/)) {
      console.warn('⚠️  Phone number format may be invalid:', phone);
    }
    
    console.log('✅ Processed request - Phone:', phone, 'Message:', message.substring(0, 50) + (message.length > 50 ? '...' : ''));

    const messagingGate = await assertWhatsAppMessagingActive(userId, projectId);
    if (!messagingGate.ok) {
      return res.status(403).json({
        success: false,
        msg: messagingGate.message,
        message: messagingGate.message,
        redirectUrl: messagingGate.redirectUrl || '/connect-whatsapp',
        paymentStatus: messagingGate.paymentStatus,
        accountStatus: messagingGate.accountStatus,
      });
    }

    const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
    const phoneNumberId = waCandidates[0]?.phoneNumberId;
    const permanentToken = waCandidates[0]?.accessToken;
    const apiVersion = waCandidates[0]?.apiVersion || 'v22.0';

    console.log('🔍 WhatsApp send credentials:', {
      source: waCandidates[0]?.source,
      candidateCount: waCandidates.length,
      phoneNumberId: phoneNumberId ? '✓' : '✗',
      token: permanentToken ? '✓' : '✗',
    });

    if (!phoneNumberId || !permanentToken) {
      console.error("❌ Missing Meta WhatsApp API credentials!");
      console.error("  PHONE_NUMBER_ID:", phoneNumberId ? "✓ Found" : "✗ Missing");
      console.error("  TOKEN:", permanentToken ? "✓ Found" : "✗ Missing");
      console.error("\n📝 To enable message sending, add these to your .env file:");
      console.error("  WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id");
      console.error("  WHATSAPP_TOKEN=your_permanent_access_token");
      console.error("\n💡 Alternative names also supported:");
      console.error("  PHONE_NUMBER_ID or Phone_Number_ID");
      console.error("  PERMANENT_TOKEN or Whatsapp_Token");
      
      // Still allow the request to proceed - save to DB but mark as failed
      // This allows testing the endpoint structure even without API credentials
      // Find or create contact
      let contact = await Contact.findOne({ where: { phone, userId, projectId } });
      if (!contact) {
        contact = await Contact.create({
          userId,
          projectId,
          phone,
          name: phone,
          status: 'active'
        });
      }

      // Save message with failed status (API credentials missing)
      console.error('💾 Saving message to database with status=failed (credentials missing)...');
      const saved = await InboxMessage.create({
        contactId: contact.id,
        userId,
        projectId,
        direction: "outgoing",
        message,
        type: "text",
        status: "failed",
        timestamp: new Date()
      });
      console.error('💾 Message saved to DB with status=failed (ID:', saved.id + ')');
      console.error('   Reason: API credentials not configured');

      return res.json({ 
        success: false, 
        msg: "API credentials not configured. Message saved but not sent.",
        data: saved,
        warning: {
          PHONE_NUMBER_ID: phoneNumberId ? "Found" : "Missing",
          PERMANENT_TOKEN: permanentToken ? "Found" : "Missing",
          message: "Add credentials to .env file to enable actual message sending"
        }
      });
    }

    // Find contact - try exact match first, then normalize and try again
    let contact = await Contact.findOne({ where: { phone, userId, projectId } });
    
    // If not found, try creating contact automatically (for new conversations)
    if (!contact) {
      console.log('⚠️  Contact not found, creating new contact for phone:', phone);
      try {
        contact = await Contact.create({
          userId,
          projectId,
          phone,
          name: phone, // Default name to phone number
          status: 'active'
        });
        console.log('✅ Created new contact (ID:', contact.id + ')');
      } catch (createError) {
        console.error('❌ Error creating contact:', createError);
        return res.status(404).json({ 
          success: false, 
          msg: `Contact not found and could not be created for phone: ${phone}`,
          error: createError.message
        });
      }
    } else {
      console.log('✅ Contact found (ID:', contact.id + ')');
    }

    // Conversation billing/quota enforcement (24-hour rolling).
    // Charges only when a new conversation session starts.
    let billing = { allowed: true, wasNew: false };
    let billingAllowed = true;
    try {
      billing = await upsertConversationWithQuota(userId, phone);
      billingAllowed = !!billing.allowed;
    } catch (billingErr) {
      console.error('Conversation billing check failed (messageController.sendMessage):', billingErr?.message || billingErr);
    }

    if (!billingAllowed) {
      try {
        await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: "outgoing",
          message,
          type: "text",
          status: "failed",
          timestamp: new Date()
        });
      } catch (saveErr) {
        console.error('Error saving blocked message by quota:', saveErr);
      }

      return res.status(403).json({
        success: false,
        msg: "Blocked (conversation limit reached)"
      });
    }

    const wccCheck = await requireWccForOutgoing(projectId, billing, { isTemplate: false, customerPhone: phone });
    if (!wccCheck.ok) {
      try {
        await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: "outgoing",
          message,
          type: "text",
          status: "failed",
          timestamp: new Date()
        });
      } catch (saveErr) {
        console.error('Error saving blocked message by WCC:', saveErr);
      }

      return res.status(403).json({
        success: false,
        msg: `Insufficient WhatsApp Conversation Credits (WCC): need ${wccCheck.charge}, have ${wccCheck.balance}. Add WCC from the dashboard, or set DISABLE_WCC_ENFORCEMENT=1 on the server for development.`,
        wcc: {
          required: wccCheck.charge,
          balance: wccCheck.balance
        }
      });
    }

    // Send via Meta API (works for both verified and non-verified numbers)
    // For non-verified: Meta will enforce 24-hour restriction automatically
    // For verified: No restriction, message will send
    const apiPayload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message }
    };
    
    console.log('📤 Sending to Meta API...');
    console.log('  Payload:', JSON.stringify(apiPayload, null, 2));
    console.log('  Phone Number ID:', phoneNumberId);
    console.log('  Token (first 20 chars):', permanentToken ? permanentToken.substring(0, 20) + '...' : 'NONE');
    
    let response;
    try {
      const sent = await postWhatsAppMessage(waCandidates, apiPayload, { userId, projectId });
      response = sent.response;
      
      // Log successful response
      console.log('✅ Meta API Response Status:', response.status);
      console.log('✅ Meta API Response Data:', JSON.stringify(response.data, null, 2));
      console.log('✅ Used credential source:', sent.creds?.source || 'unknown');
      
      const waMessageId = response.data.messages?.[0]?.id;
      console.log('✅ WhatsApp Message ID:', waMessageId || 'N/A');
      
      if (!response.data.messages || !waMessageId) {
        console.error('⚠️  WARNING: Meta API response missing message ID!');
        console.error('  Response:', JSON.stringify(response.data, null, 2));
        throw new Error(
          formatMetaApiErrorMessage({ response: { data: response.data } }) ||
            'WhatsApp API did not return a message id'
        );
      }
      console.log('✅ Message successfully sent to WhatsApp! Message ID:', waMessageId);
    } catch (apiError) {
      console.error("❌ Meta API Error occurred!");
      console.error("  Error Type:", apiError.name);
      console.error("  Error Message:", apiError.message);
      console.error("  Response Status:", apiError.response?.status);
      console.error("  Response Status Text:", apiError.response?.statusText);
      console.error("  Response Data:", JSON.stringify(apiError.response?.data || {}, null, 2));
      console.error("  Request URL:", apiError.config?.url);
      console.error("  Request Method:", apiError.config?.method);
      
      const errorData = apiError.response?.data?.error || {};
      const errorCode = errorData.code;
      const errorMsg = apiError.metaMessage || errorData.message || apiError.message || "Failed to send via Meta API";
      
      console.error("  Error Code:", errorCode || 'N/A');
      console.error("  Error Message:", errorMsg);
      
      // Check if it's a 24-hour restriction error (for non-verified numbers)
      // Error code 131047 = session expired; 131026 = message undeliverable (different issue)
      const is24HourError = errorCode === 131047 ||
                           errorMsg.toLowerCase().includes('24 hour') ||
                           errorMsg.toLowerCase().includes('session') ||
                           errorMsg.toLowerCase().includes('template required');
      
      // Save failed message with error details
      let errorMessageToSave = errorMsg;
      if (errorCode) {
        errorMessageToSave = `[${errorCode}] ${errorMsg}`;
      }
      
      console.error('💾 Saving failed message to database with error details...');
      try {
        const failedMessage = await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: "outgoing",
          message,
          type: "text",
          status: "failed",
          timestamp: new Date()
          // Note: If InboxMessage table has errorMessage field, add:
          // errorMessage: errorMessageToSave
        });
        console.error('💾 Failed message saved to DB (ID:', failedMessage.id + ')');
        console.error('   Error:', errorMessageToSave);
        console.error('   Error Code:', errorCode || 'N/A');
      } catch (saveError) {
        console.error("❌ Error saving failed message to DB:", saveError);
      }

      // Return specific message for 24-hour restriction
      if (is24HourError) {
        console.error('⚠️  24-HOUR SESSION EXPIRED - User must send message first or use template');
        return res.json({ 
          success: false,
          sessionExpired: true,
          msg: "24 hour session expired. User must send a message first, or use /send-template to send a template message.",
          error: errorMsg,
          errorCode: errorCode
        });
      }

      // Other API errors
      console.error('❌ META API CALL FAILED - Message not sent to WhatsApp');
      const friendlyMsg = formatMetaApiErrorMessage(apiError) || errorMsg;
      const httpStatus = resolveWhatsAppApiHttpStatus(apiError, 502);
      return res.status(httpStatus).json({ 
        success: false, 
        msg: friendlyMsg,
        message: friendlyMsg,
        error: friendlyMsg,
        wabaUnverified: isUnverifiedWabaError(apiError),
        redirectUrl: isUnverifiedWabaError(apiError) ? '/connect-whatsapp' : undefined,
        errorCode: errorCode || 'UNKNOWN',
        details: apiError?.response?.data || apiError.message,
      });
    }

    const waMessageId = response.data.messages?.[0]?.id || null;

    res.json({
      success: true,
      data: {
        waMessageId,
        contactId: contact.id,
        message,
        status: 'sent',
        type: 'outgoing',
      },
    });

    setImmediate(() => {
      (async () => {
        try {
          const saved = await InboxMessage.create({
            contactId: contact.id,
            userId,
            projectId,
            direction: 'outgoing',
            message,
            type: 'text',
            status: 'sent',
            waMessageId,
            timestamp: new Date(),
          });

          try {
            await debitWccAfterSuccessfulMetaSend(projectId, wccCheck.ownerUserId, billing, {
              isTemplate: false,
              customerPhone: phone,
            });
          } catch (wccErr) {
            console.error('WCC deduct after message send:', wccErr?.message || wccErr);
          }

          try {
            await contact.update({ lastContacted: new Date() });
          } catch (updateError) {
            console.error('Error updating contact:', updateError);
          }

          try {
            const messageData = {
              id: saved.id,
              contactId: contact.id,
              phone,
              content: saved.message || message,
              type: 'outgoing',
              status: saved.status,
              sentAt: saved.timestamp ? saved.timestamp.toISOString() : new Date().toISOString(),
              createdAt: saved.createdAt ? saved.createdAt.toISOString() : new Date().toISOString(),
              waMessageId: saved.waMessageId,
            };
            socketService.emitToContact(contact.id, 'new-message', messageData);
            socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
          } catch (socketError) {
            console.error('Error emitting socket:', socketError);
          }
        } catch (dbError) {
          console.error('Post-send inbox save failed (message already sent):', dbError?.message || dbError);
        }
      })();
    });
    return;
  } catch (err) {
    console.error("Outgoing Error:", err);
    console.error("Error Stack:", err.stack);
    const projectId = Number(req?.projectId) || null;
    
    // Try to get contact for error handling
    let contact = null;
    try {
      const phone = req.body?.phone;
      const userId = req.user?.id;
      if (phone && userId) {
        contact = await Contact.findOne({ where: { phone, userId, projectId } });
      }
    } catch (contactError) {
      console.error("Error finding contact for error log:", contactError);
    }

    // Save failed message
    try {
      await InboxMessage.create({
        contactId: contact?.id || null,
        userId: req.user?.id || null,
        projectId,
        direction: "outgoing",
        message: req.body?.message || "Unknown",
        type: "text",
        status: "failed",
        timestamp: new Date()
      });
    } catch (saveError) {
      console.error("Error saving failed message:", saveError);
    }

    return res.json({ 
      success: false, 
      msg: `Message send failed: ${err.message || "Unknown error"}`,
      error: err.message
    });
  }
};

// Delete message (hard delete in DB)
exports.deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const ref = parseInboxMessageRef(req.params.messageId);
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Invalid message id' });
    }

    if (ref.kind === 'meta') {
      const row = await MetaMessage.findByPk(ref.id);
      if (!row || Number(row.projectId) !== Number(projectId)) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }
      await row.destroy();
      return res.json({ success: true, message: 'Message deleted successfully' });
    }

    const message = await Message.findByPk(ref.id, {
      include: [{
        model: Contact,
        where: { userId },
        required: true
      }]
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    await message.destroy();

    socketService.emitToContact(message.contactId, 'message-deleted', {
      messageId: message.id
    });

    res.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Forward message
exports.forwardMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const messageIdRaw = req.params.messageId || req.body.messageId;
    const { contactIds } = req.body;

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Contact IDs are required'
      });
    }

    const ref = parseInboxMessageRef(messageIdRaw);
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Invalid message id' });
    }

    let content = '';
    if (ref.kind === 'meta') {
      const row = await MetaMessage.findByPk(ref.id);
      if (!row || Number(row.projectId) !== Number(projectId)) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }
      content = row.message_text || '';
    } else {
      const originalMessage = await Message.findByPk(ref.id, {
        include: [{
          model: Contact,
          where: { userId },
          required: true
        }]
      });
      if (!originalMessage) {
        return res.status(404).json({
          success: false,
          error: 'Message not found'
        });
      }
      content = originalMessage.content || '';
    }

    const forwardedMessages = [];

    for (const contactId of contactIds) {
      const contact = await Contact.findOne({
        where: { id: contactId, userId }
      });

      if (!contact) continue;

      const forwardedMessage = await Message.create({
        contactId: contact.id,
        content: content || '[Empty message]',
        type: 'outgoing',
        status: 'sent',
        sentAt: new Date(),
        projectId: contact.projectId != null ? contact.projectId : projectId
      });

      forwardedMessages.push(forwardedMessage);

      socketService.emitToContact(contact.id, 'new-message', forwardedMessage);
    }

    res.json({
      success: true,
      messages: forwardedMessages,
      count: forwardedMessages.length
    });
  } catch (error) {
    console.error('Error forwarding message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Add reaction to message
exports.addReaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { emoji } = req.body;
    if (!emoji) {
      return res.status(400).json({
        success: false,
        error: 'Emoji is required'
      });
    }

    const ref = parseInboxMessageRef(req.params.messageId);
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Invalid message id' });
    }

    if (ref.kind === 'meta') {
      const row = await MetaMessage.findByPk(ref.id);
      if (!row || Number(row.projectId) !== Number(projectId)) {
        return res.status(404).json({ success: false, error: 'Message not found' });
      }
      let reactions = Array.isArray(row.reactions) ? [...row.reactions] : [];
      const existingIndex = reactions.findIndex((r) => r.userId === userId && r.emoji === emoji);
      if (existingIndex >= 0) {
        reactions.splice(existingIndex, 1);
      } else {
        reactions.push({ userId, emoji, createdAt: new Date().toISOString() });
      }
      await row.update({ reactions });
      const variants = digitsOnlyPhoneVariants(row.phone);
      const contact = await Contact.findOne({
        where: { userId, projectId, phone: { [Op.in]: variants } }
      });
      if (contact) {
        socketService.emitToContact(contact.id, 'message-reaction', {
          messageId: `meta_${row.id}`,
          reactions
        });
      }
      return res.json({ success: true, reactions });
    }

    const message = await Message.findByPk(ref.id, {
      include: [{
        model: Contact,
        where: { userId },
        required: true
      }]
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    const reactions = message.reactions || [];
    const existingIndex = reactions.findIndex(r => r.userId === userId && r.emoji === emoji);

    if (existingIndex >= 0) {
      reactions.splice(existingIndex, 1);
    } else {
      reactions.push({
        userId,
        emoji,
        createdAt: new Date().toISOString()
      });
    }

    await message.update({ reactions });

    socketService.emitToContact(message.contactId, 'message-reaction', {
      messageId: message.id,
      reactions: message.reactions
    });

    res.json({
      success: true,
      reactions: message.reactions
    });
  } catch (error) {
    console.error('Error adding reaction:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Search messages in conversation
exports.searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId, query, limit = 50, offset = 0 } = req.query;

    if (!contactId || !query) {
      return res.status(400).json({
        success: false,
        error: 'Contact ID and search query are required'
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

    const messages = await Message.findAll({
      where: {
        contactId: contact.id,
        // Note: isDeleted column doesn't exist in Messages table
        content: {
          [Op.like]: `%${query}%`
        }
      },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['sentAt', 'DESC']]
    });

    res.json({
      success: true,
      messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Send template message (for non-verified numbers or starting conversation)
exports.sendTemplate = async (req, res) => {
  try {
    // Get userId from authenticated user
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { phone, templateName, templateLanguage = "en_US", templateParams = [] } = req.body;
    const normalizedPhone = normalizeWhatsAppRecipient(phone);

    // Validate input
    if (!normalizedPhone || !templateName) {
      return res.json({
        success: false,
        msg: "Missing required fields: phone, templateName"
      });
    }

    const templateRecord = await loadApprovedTemplateForSend({ templateName, userId, projectId });
    let templateContent = templateRecord?.content || `Template: ${templateName}`;
    const metaTemplateName =
      normalizeMetaTemplateName(templateRecord?.name || templateName) ||
      String(templateName || '').trim().toLowerCase();

    let resolvedComponents = [];
    try {
      resolvedComponents = await resolveTemplateComponentsForSend(templateRecord, {
        userId,
        projectId,
        templateName: metaTemplateName,
      });
      const bodyComponent = (resolvedComponents || []).find(
        (c) => String(c?.type || '').toUpperCase() === 'BODY'
      );
      if (bodyComponent?.text) {
        templateContent = bodyComponent.text;
      }
    } catch (templateError) {
      console.log('Could not resolve template components, using local content:', templateError.message);
    }

    const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);

    if (!waCandidates.some((c) => c?.phoneNumberId && c?.accessToken)) {
      return res.status(400).json({
        success: false,
        msg: 'WhatsApp is not connected. Set Phone_Number_ID and WHATSAPP_TOKEN in server .env, or complete Meta onboarding.',
      });
    }

    const phoneVariants = phoneVariantsForLookup(normalizedPhone);

    let contact = await findContactForProjectSend({
      phoneVariants,
      normalizedPhone,
      projectId,
      userId,
    });
    contact = await ensureContactOptInForActiveChat(contact, normalizedPhone, projectId);

    if (contact && contact.status !== 'unsubscribed' && !contact.whatsappOptInAt) {
      try {
        await contact.update({ whatsappOptInAt: new Date(), status: 'active' });
        await contact.reload();
      } catch (optInErr) {
        console.warn('sendTemplate opt-in ensure:', optInErr?.message || optInErr);
      }
    }

    const isOptedIn =
      contact.status !== 'unsubscribed' &&
      !!contact.whatsappOptInAt;

    const templateVars =
      templateRecord?.variables && typeof templateRecord.variables === 'object'
        ? templateRecord.variables
        : {};
    let headerMediaUrl =
      req.body?.headerMediaUrl ||
      req.body?.header_media_url ||
      templateVars.headerMediaUrl ||
      templateVars.header_media_url ||
      null;

    if (!headerMediaUrl) {
      try {
        headerMediaUrl = await resolveHeaderFromCampaign(metaTemplateName, projectId);
      } catch (_) {
        /* optional */
      }
    }

    if (!isOptedIn) {
      try {
        await saveFailedTemplateInboxRow({
          contact,
          userId,
          projectId,
          templateRecord,
          templateContent,
          metaTemplateName,
          headerMediaUrl,
        });
      } catch (saveErr) {
        console.error('Error saving blocked template:', saveErr);
      }

      return res.status(403).json({
        success: false,
        msg: "Blocked (opt-out / not opted-in)",
        details: {
          contactId: contact.id,
          phone: normalizedPhone,
          status: contact.status,
          whatsappOptInAt: contact.whatsappOptInAt
        }
      });
    }

    // Conversation billing/quota enforcement (24-hour rolling).
    const ownerId = await Project.getProjectOwnerId(projectId);
    const billingAccountId =
      contact.userId != null && Number(contact.userId) > 0
        ? Number(contact.userId)
        : ownerId != null && Number(ownerId) > 0
          ? Number(ownerId)
          : Number(userId);

    let billing = { allowed: true, wasNew: false };
    let billingAllowed = true;
    try {
      billing = await upsertConversationWithQuota(billingAccountId, normalizedPhone);
      billingAllowed = !!billing.allowed;
    } catch (billingErr) {
      console.error('Conversation billing check failed (messageController.sendTemplate):', billingErr?.message || billingErr);
    }

    if (!billingAllowed) {
      try {
        await saveFailedTemplateInboxRow({
          contact,
          userId,
          projectId,
          templateRecord,
          templateContent,
          metaTemplateName,
          headerMediaUrl,
        });
      } catch (saveErr) {
        console.error('Error saving blocked template by quota:', saveErr);
      }

      return res.status(403).json({
        success: false,
        msg: "Blocked (conversation limit reached)"
      });
    }

    const templateBillingCategory = resolveTemplateBillingCategory({
      category: templateRecord?.category,
      metaCategory: templateRecord?.metaCategory,
      variables: templateRecord?.variables,
    });

    const wccCheck = await requireWccForOutgoing(projectId, billing, {
      isTemplate: true,
      customerPhone: normalizedPhone,
      billingCategory: templateBillingCategory,
      userId,
    });
    const wccBalance =
      wccCheck.balance ??
      (await Project.getWccCredits(projectId, wccCheck.ownerUserId || billingAccountId));
    if (!wccCheck.ok || wccBalance <= 0) {
      try {
        await saveFailedTemplateInboxRow({
          contact,
          userId,
          projectId,
          templateRecord,
          templateContent,
          metaTemplateName,
          headerMediaUrl,
        });
      } catch (saveErr) {
        console.error('Error saving blocked template by WCC:', saveErr);
      }

      return res.status(403).json({
        success: false,
        msg: 'Recharge for WCC to send template message.',
        message: 'Recharge for WCC to send template message.',
        wcc: {
          required: wccCheck.charge,
          balance: wccBalance,
        },
      });
    }

    // Add components only if templateParams provided
    // Ensure templateParams is an array
    let paramsArray = [];
    if (templateParams) {
      if (Array.isArray(templateParams)) {
        paramsArray = templateParams;
      } else if (typeof templateParams === 'string') {
        try {
          paramsArray = JSON.parse(templateParams);
          if (!Array.isArray(paramsArray)) {
            paramsArray = [];
          }
        } catch (e) {
          paramsArray = [];
        }
      } else if (typeof templateParams === 'object') {
        paramsArray = Object.values(templateParams);
      }
    }

    // Validate template parameter count against local template placeholders.
    // This avoids Meta error (#132000) with a clearer API response.
    const requiredVarNums = extractTemplateVariableNumbers(templateContent);
    const expectedParamsCount = requiredVarNums.length;
    const providedParamsCount = paramsArray.length;

    if (expectedParamsCount > 0 && providedParamsCount !== expectedParamsCount) {
      return res.status(400).json({
        success: false,
        msg: "Invalid templateParams count",
        details: {
          templateName,
          templateLanguage,
          expectedParamsCount,
          providedParamsCount,
          expectedPlaceholders: requiredVarNums.map((n) => `{{${n}}}`)
        }
      });
    }

    if (expectedParamsCount === 0) {
      paramsArray = [];
    }

    let resolvedLanguage = String(templateLanguage || 'en_US').trim() || 'en_US';
    try {
      const metaTpl = await fetchMetaTemplateByName(metaTemplateName, userId, projectId);
      if (metaTpl?.language) {
        resolvedLanguage = String(metaTpl.language);
      }
    } catch (langErr) {
      console.warn('Could not resolve Meta template language:', langErr?.message || langErr);
    }

    // Build template payload
    const templatePayload = {
      messaging_product: "whatsapp",
      to: normalizedPhone,
      type: "template",
      template: {
        name: metaTemplateName,
        language: { code: resolvedLanguage }
      }
    };

    const sendSpec = parseTemplateSendSpec(resolvedComponents, templateContent, {
      templateType: templateVars.templateType || null,
      carouselMediaType: templateVars.carouselMediaType || null,
      carouselCards: Array.isArray(templateVars.carouselCards) ? templateVars.carouselCards : null,
    });

    let carouselCardMediaUrls = req.body?.carouselCardMediaUrls || req.body?.carousel_card_media_urls;
    if (typeof carouselCardMediaUrls === 'string') {
      try {
        carouselCardMediaUrls = JSON.parse(carouselCardMediaUrls);
      } catch {
        carouselCardMediaUrls = [];
      }
    }
    if (!Array.isArray(carouselCardMediaUrls)) {
      carouselCardMediaUrls = [];
    }
    carouselCardMediaUrls = carouselCardMediaUrls
      .map((u) => toPermanentUploadPath(u) || String(u || '').trim())
      .filter(Boolean);

    headerMediaUrl = resolveDisplayableHeaderMediaUrl(
      headerMediaUrl,
      resolveHeaderImageFromComponents(resolvedComponents)
    );

    if (sendSpec?.isCarousel) {
      const needCount = sendSpec.carouselCardCount || carouselCardMediaUrls.length;
      const validUrls = carouselCardMediaUrls.filter((u) => toPublicMediaUrl(u));
      if (needCount > 0 && validUrls.length !== needCount) {
        return res.status(400).json({
          success: false,
          msg: `This carousel template requires ${needCount} card media file(s). Upload image or video for each card before sending.`,
          details: {
            templateName: metaTemplateName,
            carouselCardCount: needCount,
            carouselCardHeaderFormat: sendSpec.carouselCardHeaderFormat,
          },
        });
      }
    } else if (sendSpec?.needsHeaderMedia && !toPublicMediaUrl(headerMediaUrl)) {
      return res.status(400).json({
        success: false,
        msg: 'This template requires header media (image/video/document). Upload header media in Templates or pass headerMediaUrl.',
        details: {
          templateName: metaTemplateName,
          headerFormat: sendSpec.headerFormat,
        },
      });
    }

    const audienceMember = {};
    const bodyVarNums =
      sendSpec?.bodyVarNums?.length > 0
        ? sendSpec.bodyVarNums
        : extractTemplateVariableNumbers(templateContent);
    bodyVarNums.forEach((varNum, idx) => {
      const val = paramsArray[idx];
      audienceMember[`var${varNum}`] = val == null ? '' : String(val);
    });

    const clientPreview = buildClientTemplatePreview(
      enrichTemplateRecordWithComponents(templateRecord, resolvedComponents),
      templateContent,
      {
        templateName: metaTemplateName,
        templateParams: paramsArray,
        headerImageUrl: headerMediaUrl,
        carouselCardMediaUrls: sendSpec?.isCarousel ? carouselCardMediaUrls : undefined,
      }
    );

    let waTemplateComponents;
    let headerMediaPhoneId = null;
    try {
      if (sendSpec?.isCarousel) {
        const cardHeaderMediaIds = [];
        let carouselMetaUploadError = null;
        for (let i = 0; i < carouselCardMediaUrls.length; i += 1) {
          const cardUrl = carouselCardMediaUrls[i];
          const publicUrl = toPublicMediaUrl(cardUrl);
          if (!publicUrl) {
            return res.status(400).json({
              success: false,
              msg: `Invalid media URL for carousel card ${i + 1}. Choose media from Media Library and retry.`,
              details: {
                templateName: metaTemplateName,
                cardIndex: i,
                headerFormat: sendSpec.carouselCardHeaderFormat,
              },
            });
          }

          let mediaId = null;
          const uploaded = await resolveHeaderMediaIdForSend(
            waCandidates,
            cardUrl,
            sendSpec.carouselCardHeaderFormat,
            { preferredPhoneNumberId: headerMediaPhoneId || undefined }
          );
          if (uploaded?.mediaId) {
            mediaId = uploaded.mediaId;
            headerMediaPhoneId = uploaded.phoneNumberId || headerMediaPhoneId;
          } else if (uploaded?.lastError) {
            carouselMetaUploadError = uploaded.lastError;
          }

          cardHeaderMediaIds.push(mediaId);
        }

        for (let i = 0; i < cardHeaderMediaIds.length; i += 1) {
          const cardUrl = carouselCardMediaUrls[i];
          const publicUrl = toPublicMediaUrl(cardUrl);
          const needsMetaId =
            String(sendSpec.carouselCardHeaderFormat || '').toUpperCase() === 'VIDEO' ||
            !publicUrl;
          if (needsMetaId && !cardHeaderMediaIds[i]) {
            const isVideo =
              String(sendSpec.carouselCardHeaderFormat || '').toUpperCase() === 'VIDEO';
            const metaMsg = carouselMetaUploadError
              ? `Could not upload ${isVideo ? 'video' : 'image'} for carousel card ${i + 1}: ${carouselMetaUploadError}`
              : `Could not upload ${isVideo ? 'video' : 'image'} for carousel card ${i + 1}. Choose media from Media Library and retry.`;
            return res.status(400).json({
              success: false,
              msg: metaMsg,
              details: {
                templateName: metaTemplateName,
                cardIndex: i,
                headerFormat: sendSpec.carouselCardHeaderFormat,
                metaUploadError: carouselMetaUploadError,
                phoneNumberId: headerMediaPhoneId || null,
              },
            });
          }
        }

        waTemplateComponents = buildWhatsAppCarouselTemplateComponents({
          sendSpec,
          resolvedComponents,
          cardHeaderMediaIds,
          cardHeaderMediaUrls: carouselCardMediaUrls,
          audienceMember,
        });
      } else {
        let headerMediaId = null;
        if (sendSpec?.needsHeaderMedia && headerMediaUrl) {
          const uploaded = await resolveHeaderMediaIdForSend(
            waCandidates,
            headerMediaUrl,
            sendSpec.headerFormat
          );
          if (uploaded?.mediaId) {
            headerMediaId = uploaded.mediaId;
            headerMediaPhoneId = uploaded.phoneNumberId || null;
          }
          if (!headerMediaId && !toPublicMediaUrl(headerMediaUrl)) {
            return res.status(400).json({
              success: false,
              msg: 'Could not upload header media for this template. Choose media from Media Library and retry.',
              details: { templateName: metaTemplateName, headerFormat: sendSpec.headerFormat },
            });
          }
        }

        waTemplateComponents = buildWhatsAppTemplateComponents({
          sendSpec,
          headerMediaUrl,
          headerMediaId,
          audienceMember,
        });

        const buttonComponents = extractDynamicUrlButtonComponents(resolvedComponents, audienceMember);
        if (buttonComponents.length) {
          waTemplateComponents = [...(waTemplateComponents || []), ...buttonComponents];
        }
      }
    } catch (componentErr) {
      console.warn('Template components build failed:', componentErr.message);
      return res.status(400).json({
        success: false,
        msg: componentErr.message || 'Could not build template components for send',
        details: {
          templateName: metaTemplateName,
          headerFormat: sendSpec?.headerFormat || null,
        },
      });
    }

    if (waTemplateComponents?.length) {
      templatePayload.template.components = waTemplateComponents;
    } else if (paramsArray.length > 0) {
      templatePayload.template.components = [
        {
          type: "BODY",
          parameters: paramsArray.map((param) => ({
            type: "text",
            text: typeof param === 'string' ? param : String(param),
          })),
        },
      ];
    }

    const snapshotForInbox = finalizeTemplateSnapshotForInbox(
      clientPreview,
      templatePayload,
      headerMediaUrl,
      sendSpec?.isCarousel ? { carouselCardMediaUrls } : {}
    );

    const inboxPersistMediaUrl = (() => {
      if (snapshotForInbox?.isCarousel && Array.isArray(snapshotForInbox.carouselCards)) {
        const first = snapshotForInbox.carouselCards.find((c) => c?.headerImageUrl);
        return first?.headerImageUrl || null;
      }
      return snapshotForInbox?.headerImageUrl || snapshotForInbox?.header?.url || null;
    })();

    let response;
    try {
      let sent;
      const templateSendOpts = {
        userId,
        projectId,
        preferredPhoneNumberId: headerMediaPhoneId || undefined,
        isMarketing: templateBillingCategory === 'marketing',
      };
      try {
        sent = await postWhatsAppTemplateMessage(waCandidates, templatePayload, templateSendOpts);
      } catch (primarySendErr) {
        sent = await postWhatsAppTemplateMessage(waCandidates, templatePayload, {
          ...templateSendOpts,
          isMarketing: templateBillingCategory !== 'marketing',
        });
      }
      response = sent.response;
      console.log('✅ Template sent via Meta API:', response.data, `(source: ${sent.creds?.source})`);
    } catch (apiError) {
      console.error('Meta API Template Error (all credentials failed):', apiError?.response?.data || apiError);

      try {
        await InboxMessage.create({
          contactId: contact.id,
          userId,
          projectId,
          direction: 'outgoing',
          message: snapshotForInbox?.body || templateContent,
          type: 'text',
          status: 'failed',
          isTemplateSend: true,
          templateName: metaTemplateName,
          templateSnapshot: snapshotForInbox ? JSON.stringify(snapshotForInbox) : null,
          mediaUrl: inboxPersistMediaUrl,
          timestamp: new Date(),
        });
      } catch (saveError) {
        console.error('Error saving failed template:', saveError);
      }

      const userMsg = formatMetaApiErrorMessage(apiError);
      const displayMsg = userMsg ? `WhatsApp API: ${userMsg}` : 'Failed to send template';
      const httpStatus = resolveWhatsAppApiHttpStatus(apiError, 502);

      return res.status(httpStatus).json({
        success: false,
        msg: displayMsg,
        message: displayMsg,
        error: userMsg || apiError?.message,
        wabaUnverified: isUnverifiedWabaError(apiError),
        redirectUrl: isUnverifiedWabaError(apiError) ? '/connect-whatsapp' : undefined,
        details: apiError?.response?.data || null,
      });
    }

    // Extract WhatsApp message ID from response (Graph API + Direct API shapes)
    const waMessageId =
      response?.data?.messages?.[0]?.id ||
      response?.data?.message?.id ||
      response?.data?.data?.messages?.[0]?.id ||
      null;
    if (!waMessageId) {
      const userMsg =
        formatMetaApiErrorMessage({ response: { data: response?.data } }) ||
        'WhatsApp API did not return a message id';
      try {
        await saveFailedTemplateInboxRow({
          contact,
          userId,
          projectId,
          templateRecord,
          templateContent,
          metaTemplateName,
          headerMediaUrl,
        });
      } catch (saveErr) {
        console.error('Error saving failed template (missing wamid):', saveErr);
      }
      return res.status(502).json({
        success: false,
        msg: userMsg,
        message: userMsg,
        error: response?.data || null,
      });
    }

    let wccCredits = null;
    let savedMessage = null;
    try {
      savedMessage = await InboxMessage.create({
        contactId: contact.id,
        userId,
        projectId,
        direction: 'outgoing',
        message: snapshotForInbox?.body || templateContent,
        type: 'text',
        status: 'sent',
        isTemplateSend: true,
        templateName: metaTemplateName,
        templateSnapshot: snapshotForInbox ? JSON.stringify(snapshotForInbox) : null,
        mediaUrl: inboxPersistMediaUrl,
        payload: JSON.stringify({ template: templatePayload.template }),
        waMessageId,
        timestamp: new Date(),
      });

      try {
        const livePreviewText =
          snapshotForInbox?.body ||
          (isTemplateMarkerContent(templateContent) ? '' : templateContent) ||
          `Template: ${metaTemplateName}`;
        await syncOutboundToConversation({
          phone: normalizedPhone,
          text: livePreviewText,
          projectId,
          createdAt: savedMessage.timestamp || new Date(),
        });
      } catch (syncLiveErr) {
        console.warn('syncOutboundToConversation after template send:', syncLiveErr?.message || syncLiveErr);
      }
    } catch (dbError) {
      console.error('Post-send template inbox save failed:', dbError?.message || dbError);
    }

    res.json({
      success: true,
      msg: 'Template sent successfully',
      waMessageId,
      saved: Boolean(savedMessage?.id),
      messageId: savedMessage?.id || null,
      wccCredits,
      templateName: metaTemplateName,
      templatePreview: snapshotForInbox,
      templateSnapshot: snapshotForInbox,
    });

    setImmediate(() => {
      (async () => {
        try {
          const debit = await debitWccAfterSuccessfulMetaSend(projectId, wccCheck.ownerUserId, billing, {
            isTemplate: true,
            customerPhone: normalizedPhone,
            billingCategory: templateBillingCategory,
            userId,
            waMessageId,
            inboxMessageId: savedMessage?.id,
          });
          if (debit?.balanceAfter != null) {
            socketService.emitToUser(userId, 'wcc-quota-updated', {
              wccCredits: debit.balanceAfter,
            });
          }
        } catch (wccErr) {
          console.error('WCC deduct after template send:', wccErr?.message || wccErr);
        }

        try {
          await contact.update({ lastContacted: new Date() });
        } catch (updateError) {
          console.error('Error updating contact:', updateError);
        }

        try {
          if (savedMessage) {
            const messageData = {
              id: savedMessage.id,
              contactId: contact.id,
              phone: normalizedPhone,
              content: snapshotForInbox?.body || templateContent,
              type: 'outgoing',
              status: savedMessage.status,
              sentAt: savedMessage.timestamp ? savedMessage.timestamp.toISOString() : new Date().toISOString(),
              createdAt: savedMessage.createdAt ? savedMessage.createdAt.toISOString() : new Date().toISOString(),
              waMessageId,
              isTemplate: true,
              templateName: metaTemplateName,
              templatePreview: snapshotForInbox,
              templateSnapshot: snapshotForInbox,
              mediaUrl: inboxPersistMediaUrl,
            };
            socketService.emitToContact(contact.id, 'new-message', messageData);
            socketService.emitToUser(userId, 'inbox-update', { contactId: contact.id });
          }
        } catch (socketError) {
          console.error('Error emitting socket:', socketError);
        }
      })();
    });
    return;
  } catch (error) {
    console.error("Template Send Error:", error);
    console.error("Error stack:", error.stack);
    const userMsg = formatMetaApiErrorMessage(error);
    const errorMessage = userMsg || error.message || (typeof error === 'string' ? error : JSON.stringify(error));
    const httpStatus = resolveWhatsAppApiHttpStatus(error, 500);
    return res.status(httpStatus).json({
      success: false,
      msg: errorMessage,
      message: errorMessage,
      error: errorMessage,
      wabaUnverified: isUnverifiedWabaError(error),
      redirectUrl: isUnverifiedWabaError(error) ? '/connect-whatsapp' : undefined,
      details: error.response?.data || (error.stack ? error.stack.split('\n')[0] : null)
    });
  }
};

// Get paginated messages
exports.getMessagesPaginated = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { contactId, phone, page = 1, limit = 50 } = req.query;

    if (!contactId && !phone) {
      return res.status(400).json({
        success: false,
        error: 'Contact ID or phone is required'
      });
    }

    let contact = null;
    if (contactId) {
      contact = await Contact.findOne({
        where: { id: contactId, projectId },
      });
      if (!contact) {
        contact = await Contact.findOne({
          where: { id: contactId, userId, projectId: null },
        });
      }
    }

    if (!contact && phone) {
      const variants = digitsOnlyPhoneVariants(normalizePhone(phone));
      contact = await Contact.findOne({
        where: { phone: { [Op.in]: variants }, projectId },
      });
      if (!contact) {
        contact = await Contact.findOne({
          where: { phone: { [Op.in]: variants }, userId, projectId: null },
        });
      }
    }

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows: messages } = await Message.findAndCountAll({
      where: {
        contactId: contact.id
        // Note: isDeleted column doesn't exist in Messages table
      },
      limit: parseInt(limit),
      offset,
      order: [['sentAt', 'DESC']]
    });

    res.json({
      success: true,
      messages: messages.reverse(), // Reverse to show oldest first
      pagination: {
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / parseInt(limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching paginated messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

