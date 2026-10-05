require('dotenv').config();
const { WebhookLog, MetaMessage, Contact, Message, InboxMessage, User, WhatsAppAccount, CampaignAudience, Campaign, Template, ClientWhatsApp } = require('../models');
const { Op } = require('sequelize');
const socketService = require('../services/socketService');
const db = require('../config/db'); // MySQL pool for conversations/agent routing
const { sendText } = require('../services/whatsappService');
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('../services/wccMetaChargeService');
const { chargeWccForDeliveredInboxMessage, chargeWccForDeliveredMessage } = require('../services/wccService');
const { resolveTemplateBillingCategory } = require('../utils/messageCategoryPricing');
const {
  extractInboundText,
  extractInboundPreviewText,
  extractInboundReplyCandidates,
  getInboundMessageKind,
} = require('../utils/inboundMessageParser');
const {
  normalizeWebhookMessage,
  buildInboxRecordFromWebhook,
  buildSocketMessagePayload,
} = require('../utils/waMessageNormalizer');
const {
  downloadWhatsAppMedia,
  extractMediaIdFromPayload,
} = require('../services/metaMediaService');
const { handleInboundFlowMessage } = require('../services/flowWhatsAppService');
const { claimInboundWebhookMessage } = require('../utils/webhookInboundDedup');
const {
  persistInboundCustomerMessage,
  resolveInboundContactUserId,
} = require('../services/inboundInboxPersistService');
const { syncInboundToConversation } = require('../services/conversationInboxService');
const {
  retryInboxMessageAsReengagementTemplate,
} = require('../services/inboxReengagementSendService');
const { isSessionWindowClosedError } = require('../utils/metaWhatsAppCredentials');
const {
  resolveProjectFromWebhookPhone,
  syncProjectWhatsAppPhoneId,
  extractInboundPhoneNumberId,
  resolveInboundFlowProjectId,
} = require('../utils/projectWhatsAppPhoneSync');

// Defaults shown in the Opt-in Management UI
const OPT_IN_MESSAGE =
  'Thanks! You have been opted in for future marketing messages. You will now receive updates and notifications related to this project.';
const OPT_OUT_MESSAGE =
  'You have been opted out of your future marketing messages. If you would like to receive messages again, reply APPLY above US/APPLY.';

/** Exact keyword only — substring match wrongly treated normal chat as opt-out. */
function isWhatsappOptOutKeyword(text) {
  const normalized = String(text || '').trim().toUpperCase();
  return normalized === 'STOP' || normalized === 'UNSUBSCRIBE' || normalized === 'CANCEL';
}

function isWhatsappOptInKeyword(text) {
  const normalized = String(text || '').trim().toUpperCase();
  return normalized === 'START' || normalized === 'YES' || normalized === 'HI';
}

/** Do not send marketing opt-in/out auto-replies when a flow owns this inbound. */
function shouldSuppressConsentAutoReply(flowResult) {
  if (!flowResult) return false;
  if (flowResult.handled) return true;
  if (flowResult.flowId != null) return true;
  const src = flowResult.matchSource;
  return src === 'keyword' || src === 'session' || src === 'template_button';
}

const { phoneVariantsForLookup } = require('../utils/phoneNormalize');
const { logWebhook } = require('../utils/webhookLogger');

function summarizeWebhookPayload(payload, valueEntry = null) {
  const ve = valueEntry || payload?.entry?.[0]?.changes?.[0]?.value || null;
  const msg = ve?.messages?.[0] || payload?.message || null;
  return {
    format:
      payload?.object === 'whatsapp_business_account'
        ? 'meta'
        : payload?.event
          ? 'aisensy'
          : 'unknown',
    event: payload?.event || (msg ? 'message_received' : 'unknown'),
    phoneNumberId: extractInboundPhoneNumberId(payload, ve),
    displayPhone: ve?.metadata?.display_phone_number || null,
    wabaId: payload?.entry?.[0]?.id || payload?.waba_id || payload?.wabaId || null,
    customerPhone: msg?.from || payload?.from || null,
    messageType: msg?.type || null,
    messageText:
      msg?.text?.body ||
      msg?.button?.text ||
      msg?.button?.payload ||
      payload?.message?.text ||
      null,
    messageId: msg?.id || payload?.message_id || payload?.id || null,
  };
}

function logWebhookProjectResolved(context, extra = {}) {
  logWebhook(
    'WEBHOOK_PROJECT_RESOLVED',
    { step: 'project_mapping', ...context },
    null,
    extra
  );
}

function logWebhookFlowResult(context, result) {
  logWebhook('WEBHOOK_FLOW_RESULT', context, null, result);
}

function pickFlowLogFields(flowResult) {
  if (!flowResult) return {};
  const keys = [
    'flowId',
    'flowName',
    'matchSource',
    'matchedText',
    'reason',
    'sentCount',
    'continued',
    'started',
    'done',
    'nextNodeId',
    'fromTemplateButton',
    'waitNodeId',
    'sessionNodeId',
  ];
  const out = {};
  for (const key of keys) {
    if (flowResult[key] != null) out[key] = flowResult[key];
  }
  return out;
}

function trimWebhookBody(body) {
  try {
    const raw = JSON.stringify(body ?? {});
    if (raw.length <= 8000) return body;
    return { truncated: true, bytes: raw.length, preview: raw.slice(0, 8000) + '…' };
  } catch (_) {
    return { note: 'unserializable body' };
  }
}

let hasConversationProjectIdColumn = null;

async function resolveDefaultProjectId() {
  try {
    const [rows] = await db.query(`SELECT id FROM projects ORDER BY id ASC LIMIT 1`);
    if (Array.isArray(rows) && rows.length > 0 && rows[0].id != null) return Number(rows[0].id);
  } catch (e) {}
  return 1;
}

async function supportsConversationProjectId() {
  if (hasConversationProjectIdColumn != null) return hasConversationProjectIdColumn;
  try {
    const [rows] = await db.query("SHOW COLUMNS FROM conversations LIKE 'project_id'");
    if (Array.isArray(rows) && rows.length > 0) {
      hasConversationProjectIdColumn = true;
      return hasConversationProjectIdColumn;
    }
    await db.query('ALTER TABLE conversations ADD COLUMN project_id INT NULL');
    hasConversationProjectIdColumn = true;
  } catch (e) {
    hasConversationProjectIdColumn = false;
  }
  return hasConversationProjectIdColumn;
}

async function syncCampaignStatsFromAudience(campaignId) {
  if (!campaignId) return;
  const [total, sent, delivered, read, failed] = await Promise.all([
    CampaignAudience.count({ where: { campaignId } }),
    CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['sent', 'delivered', 'read'] } } }),
    CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['delivered', 'read'] } } }),
    CampaignAudience.count({ where: { campaignId, status: 'read' } }),
    CampaignAudience.count({ where: { campaignId, status: 'failed' } })
  ]);

  await Campaign.update(
    { total, sent, delivered, read, failed },
    { where: { id: campaignId } }
  );
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

async function reconcileContactProject(contact, resolvedProjectId) {
  if (!contact || !resolvedProjectId) return contact;

  const { findContactWithFlowSession } = require('../services/flowSessionService');
  const withSession = await findContactWithFlowSession(
    contact.phone,
    contact.userId,
    resolvedProjectId
  );
  if (withSession) return withSession;

  if (Number(contact.projectId) === Number(resolvedProjectId)) return contact;

  const scoped = await findContactByPhoneVariants(contact.phone, resolvedProjectId);
  if (scoped) return scoped;

  await contact.update({ projectId: resolvedProjectId });
  contact.projectId = resolvedProjectId;
  return contact;
}

// VERIFY WEBHOOK (for WhatsApp/Meta webhook verification)
exports.verifyWebhook = (req, res) => {
  console.log('=== WEBHOOK VERIFICATION REQUEST ===');
  console.log('Request URL:', req.url);
  console.log('Request Method:', req.method);
  console.log('Query Params:', req.query);
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.VERIFY_TOKEN || process.env.Verify_Token;
  
  console.log('Received mode:', mode);
  console.log('Received token:', token);
  console.log('Expected token:', verifyToken);
  console.log('Challenge:', challenge);

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('✅ Webhook Verified Successfully');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    console.log('Mode check:', mode === 'subscribe' ? 'PASS' : 'FAIL');
    console.log('Token check:', token === verifyToken ? 'PASS' : 'FAIL');
    res.sendStatus(403);
  }
};

// HANDLE INCOMING WEBHOOK (supports both Meta/WhatsApp and AiSensy formats)
exports.handleWebhook = async (req, res) => {
  try {
    const payload = req.body;

    console.log('\n========================================');
    console.log('=== INCOMING WEBHOOK RECEIVED ===');
    console.log('========================================');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Webhook Payload:', JSON.stringify(payload, null, 2));
    console.log('FULL BODY:');
    console.log(JSON.stringify(req.body, null, 2));

    const debugValue = payload?.entry?.[0]?.changes?.[0]?.value || null;
    const webhookSummary = summarizeWebhookPayload(payload, debugValue);

    console.log('phone_number_id:', debugValue?.metadata?.phone_number_id || webhookSummary.phoneNumberId || null);
    console.log('display_number:', debugValue?.metadata?.display_phone_number || null);
    console.log('customer_number:', debugValue?.messages?.[0]?.from || null);
    console.log('message_type:', debugValue?.messages?.[0]?.type || null);
    console.log('message_text:', debugValue?.messages?.[0]?.text?.body || null);
    console.log('button_text:', debugValue?.messages?.[0]?.button?.text || null);
    console.log('button_payload:', debugValue?.messages?.[0]?.button?.payload || null);
    console.log('inbound_reply:', extractInboundReplyCandidates(debugValue?.messages?.[0] || null));
    console.log('message_id:', debugValue?.messages?.[0]?.id || null);
    console.log('business_account_id:', payload?.entry?.[0]?.id || null);
    console.log('customer_name:', debugValue?.contacts?.[0]?.profile?.name || null);

    // 🔹 1. Save raw webhook (for debugging & audit)
    const eventType = payload.event || (payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0] ? 'message_received' : 'unknown');
    console.log('📋 Event Type:', eventType);
    
    const webhookLog = await WebhookLog.create({
      event_type: eventType,
      payload: JSON.stringify(payload)
    });
    console.log('✅ Webhook log saved to DB (ID:', webhookLog.id + ')');

    logWebhook(
      'WEBHOOK_INCOMING',
      {
        webhookLogId: webhookLog.id,
        method: req.method,
        path: req.path || req.url,
        ...webhookSummary,
      },
      trimWebhookBody(payload),
      { status: 'received' }
    );

    // Multi-client: identify client by WABA ID (entry[0].id = WABA ID)
    let resolvedClientUserId = null;
    let resolvedProjectId = null;
    if (payload.object === 'whatsapp_business_account' && payload.entry?.[0]) {
      const wabaId = payload.entry[0].id;
      const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
      const customerPhoneFromPayload = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || null;
      let webhookPhoneMapping = null;
      try {
        // whatsapp_accounts.projectId is authoritative (per-project phone mapping).
        const mapped = await resolveProjectFromWebhookPhone({ phoneNumberId, wabaId });
        webhookPhoneMapping = mapped;
        const account = mapped.account;
        if (mapped.projectId) {
          resolvedProjectId = mapped.projectId;
        }
        if (mapped.clientUserId) {
          resolvedClientUserId = mapped.clientUserId;
        } else if (account?.client_id) {
          resolvedClientUserId = Number(account.client_id);
        }
        if (account) {
          console.log('User phone_id:', account.phone_number_id || null);
          console.log('Message phone_id:', phoneNumberId || null);
          console.log('Resolved project from whatsapp_accounts:', resolvedProjectId || null);
        }
        if (resolvedProjectId && phoneNumberId) {
          syncProjectWhatsAppPhoneId(resolvedProjectId, phoneNumberId).catch(() => {});
        }
        if (resolvedProjectId == null) {
          const mappedByCustomer = await resolveProjectByCustomerPhone(customerPhoneFromPayload);
          if (mappedByCustomer) {
            resolvedProjectId = mappedByCustomer;
          }
        }
      } catch (e) {}
      if (!resolvedProjectId) {
        resolvedProjectId = await resolveDefaultProjectId();
      }
      console.log(
        'Message received for WABA:',
        wabaId,
        resolvedClientUserId != null ? `(client_id: ${resolvedClientUserId}, project_id: ${resolvedProjectId || 'null'})` : '(no client mapped)'
      );
      logWebhookProjectResolved(
        {
          source: 'meta_waba_block',
          phoneNumberId,
          wabaId,
          customerPhone: customerPhoneFromPayload,
        },
        {
          resolvedProjectId,
          resolvedClientUserId,
          mapping: webhookPhoneMapping?.account
            ? {
                whatsappAccountProjectId: webhookPhoneMapping.account.projectId,
                whatsappAccountPhoneId: webhookPhoneMapping.account.phone_number_id,
              }
            : null,
        }
      );
    }

    // AiSensy/event-based payloads may not include WABA metadata.
    if (!resolvedProjectId) {
      const aiPhoneNumberId = extractInboundPhoneNumberId(payload);
      if (aiPhoneNumberId) {
        resolvedProjectId = await resolveInboundFlowProjectId({
          phoneNumberId: aiPhoneNumberId,
          wabaId: payload?.waba_id || payload?.wabaId || null,
          fallbackProjectId: resolvedProjectId,
        });
      }
    }
    if (!resolvedProjectId && payload?.from) {
      resolvedProjectId = await resolveProjectByCustomerPhone(payload.from);
    }
    if (!resolvedProjectId) {
      resolvedProjectId = await resolveDefaultProjectId();
    }

    logWebhookProjectResolved(
      {
        source: 'final',
        ...webhookSummary,
      },
      {
        resolvedProjectId,
        resolvedClientUserId,
      }
    );

    // 🔹 2. Handle Meta webhook changes (template status + message status)
    // Wrap properly across all entries/changes (Meta can send multiple entries/changes)
    const entries = payload.entry || [];
    let firstValue = null; // keep for message handling compatibility below

    for (const entry of entries) {
      const changes = entry?.changes || [];

      for (const change of changes) {
        if (!firstValue && change?.value) firstValue = change.value;

        // 🔹 2a. Template status updates (APPROVED / REJECTED / PENDING)
        if (change?.field === 'message_template_status_update') {
          const v = change.value;
          if (!v?.message_template_name) continue;

          const metaEvent = String(v.event || '').toUpperCase();
          const templateName = String(v.message_template_name);

          const metaTemplateId = v.message_template_id != null ? String(v.message_template_id) : null;
          const reason = v.reason != null ? String(v.reason) : null;
          const rejectionInfoReason = v.rejection_info?.reason != null ? String(v.rejection_info.reason) : null;
          const rejectionRecommendation = v.rejection_info?.recommendation != null ? String(v.rejection_info.recommendation) : null;

          await Template.update(
            {
              status:
                metaEvent === 'APPROVED'
                  ? 'approved'
                  : metaEvent === 'REJECTED'
                  ? 'rejected'
                  : 'draft',
              metaTemplateId: metaTemplateId,
              metaStatus: metaEvent,
              rejectionReason: metaEvent === 'REJECTED' ? (reason || '') : null,
              rejectionInfo: metaEvent === 'REJECTED' ? rejectionInfoReason : null,
              rejectionRecommendation: metaEvent === 'REJECTED' ? rejectionRecommendation : null
            },
            { where: { name: templateName } }
          );
        }

        // 🔹 2b. Message status updates (sent/delivered/read/failed)
        // field: "messages"
        const statuses = change?.value?.statuses;
        if (statuses && Array.isArray(statuses)) {
          for (const st of statuses) {
            const waMessageId = st.id;
            const metaStatus = (st.status || '').toLowerCase();
            if (!waMessageId || !['sent', 'delivered', 'read', 'failed'].includes(metaStatus)) continue;
            const failErrors = Array.isArray(st.errors) ? st.errors : [];
            const failMsg =
              failErrors
                .map((e) => e?.message || e?.title || e?.error_data?.details || null)
                .filter(Boolean)
                .join('; ') ||
              st.error?.message ||
              null;
            if (metaStatus === 'failed') {
              console.error(
                '[WEBHOOK] Message FAILED',
                waMessageId,
                failMsg || JSON.stringify(st.errors || st.error || st)
              );
            }
            logWebhook(
              'WEBHOOK_MESSAGE_STATUS',
              {
                waMessageId,
                metaStatus,
                recipientPhone: st.recipient_id || null,
                phoneNumberId: change?.value?.metadata?.phone_number_id || null,
                resolvedProjectId,
              },
              st,
              {
                failed: metaStatus === 'failed',
                errorMessage: failMsg,
              }
            );
            try {
              const audience = await CampaignAudience.findOne({
                where: { waMessageId }
              });
              if (audience) {
                const updateData = {
                  status: metaStatus,
                  errorMessage: metaStatus === 'failed' ? failMsg : null,
                };
                if (metaStatus === 'delivered') updateData.deliveredAt = new Date(parseInt(st.timestamp, 10) * 1000 || Date.now());
                if (metaStatus === 'read') updateData.readAt = new Date(parseInt(st.timestamp, 10) * 1000 || Date.now());
                await audience.update(updateData);
                await syncCampaignStatsFromAudience(audience.campaignId);

                if (metaStatus === 'delivered') {
                  try {
                    const campaign = await Campaign.findByPk(audience.campaignId, {
                      attributes: ['id', 'userId', 'projectId', 'template_name'],
                    });
                    if (campaign?.userId) {
                      let billingCategory = 'marketing';
                      try {
                        const tpl = await Template.findOne({
                          where: {
                            name: campaign.template_name,
                            projectId: campaign.projectId,
                            userId: campaign.userId,
                          },
                        });
                        billingCategory = resolveTemplateBillingCategory(tpl);
                      } catch (_) {
                        /* optional */
                      }
                      const wccResult = await chargeWccForDeliveredMessage({
                        messageId: waMessageId,
                        userId: campaign.userId,
                        projectId: campaign.projectId,
                        category: billingCategory,
                        inside24HourWindow: false,
                        recipientPhone: audience.phone,
                      });
                      if (wccResult?.remainingBalance != null) {
                        socketService.emitToUser(campaign.userId, 'wcc-quota-updated', {
                          wccCredits: wccResult.remainingBalance,
                        });
                      }
                    }
                  } catch (wccErr) {
                    console.error('WCC charge on campaign/broadcast delivery failed:', wccErr?.message || wccErr);
                  }
                }
              }
              const inboxMsg = await InboxMessage.findOne({
                where: { waMessageId }
              });
              if (inboxMsg) {
                if (
                  metaStatus === 'failed' &&
                  isSessionWindowClosedError(failMsg) &&
                  !inboxMsg.isTemplateSend
                ) {
                  const retry = await retryInboxMessageAsReengagementTemplate(inboxMsg, failMsg);
                  if (retry?.ok) {
                    continue;
                  }
                }
                const inboxUpdate = { status: metaStatus };
                const existingPayload = (() => {
                  try {
                    const raw = inboxMsg.payload;
                    if (!raw) return {};
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    return parsed && typeof parsed === 'object' ? parsed : {};
                  } catch {
                    return {};
                  }
                })();
                if (metaStatus === 'failed' && failMsg) {
                  inboxUpdate.payload = JSON.stringify({
                    ...existingPayload,
                    error: failMsg,
                    errors: failErrors,
                    webhookStatus: st,
                  });
                }
                await inboxMsg.update(inboxUpdate);
                const statusPayload = {
                  messageId: inboxMsg.id,
                  waMessageId,
                  status: metaStatus,
                  errorMessage: metaStatus === 'failed' ? failMsg : null,
                  mediaUrl: inboxMsg.mediaUrl || null,
                };
                if (inboxMsg.templateSnapshot) {
                  try {
                    const parsedSnapshot =
                      typeof inboxMsg.templateSnapshot === 'string'
                        ? JSON.parse(inboxMsg.templateSnapshot)
                        : inboxMsg.templateSnapshot;
                    const persistedMediaUrl = String(inboxMsg.mediaUrl || '').trim();
                    if (persistedMediaUrl) {
                      parsedSnapshot.headerImageUrl =
                        parsedSnapshot.headerImageUrl || persistedMediaUrl;
                      parsedSnapshot.header =
                        parsedSnapshot.header ||
                        { type: 'image', url: parsedSnapshot.headerImageUrl || persistedMediaUrl };
                      parsedSnapshot.headerFormat = parsedSnapshot.headerFormat || 'IMAGE';
                    }
                    statusPayload.templateSnapshot = parsedSnapshot;
                    statusPayload.templatePreview = parsedSnapshot;
                  } catch (_) {
                    /* keep status payload without snapshot */
                  }
                } else if (inboxMsg.mediaUrl) {
                  statusPayload.templatePreview = {
                    headerImageUrl: inboxMsg.mediaUrl,
                    header: { type: 'image', url: inboxMsg.mediaUrl },
                    headerFormat: 'IMAGE',
                  };
                }
                if (metaStatus === 'delivered' && inboxMsg.direction === 'outgoing') {
                  try {
                    const wccResult = await chargeWccForDeliveredInboxMessage(inboxMsg, { Contact });
                    if (wccResult?.remainingBalance != null) {
                      statusPayload.wccCredits = wccResult.remainingBalance;
                    }
                  } catch (wccErr) {
                    console.error('WCC charge on delivery failed:', wccErr?.message || wccErr);
                  }
                }
                if (inboxMsg.contactId) {
                  socketService.emitToContact(inboxMsg.contactId, 'message-status-update', statusPayload);
                }
                if (inboxMsg.userId) {
                  socketService.emitToUser(inboxMsg.userId, 'message-status-update', statusPayload);
                }
              }
            } catch (e) {
              console.error('Error updating campaign status for', waMessageId, e.message);
            }
          }
        }
      }
    }

    // 🔹 3. Handle Meta/WhatsApp webhook format (entry.changes.value format) — incoming messages
    // For Cloud API, `changes[].value` contains `messages`, `contacts`, etc.
    const valueEntry = firstValue || {};
    const messageObj = valueEntry?.messages?.[0];
    let metaFormatInboundProcessed = false;
    
    if (messageObj) {
      metaFormatInboundProcessed = true;
      console.log('\n📱 Processing Meta/WhatsApp format webhook');
      // Meta/WhatsApp format
      const waId = valueEntry?.contacts?.[0]?.wa_id;
      const fromNumber = messageObj.from;
      const inboundText = extractInboundText(messageObj);
      const replyCandidates = extractInboundReplyCandidates(messageObj);
      const inboundKind = getInboundMessageKind(messageObj);
      const text = inboundText || messageObj.text?.body || '';
      const timestamp = new Date(messageObj.timestamp * 1000);

      console.log('📞 From Number:', fromNumber);
      console.log('📨 Message Type:', messageObj.type || 'unknown');
      console.log('💬 Inbound Text:', text || '(empty)');
      if (replyCandidates.length > 1) {
        console.log('💬 Reply candidates:', replyCandidates.join(' | '));
      }
      console.log('📅 Timestamp:', timestamp.toISOString());
      console.log('🆔 WA ID:', waId || 'N/A');

      if (fromNumber) {
        const inboundWaMessageId = messageObj.id || null;
        if (!claimInboundWebhookMessage(inboundWaMessageId, fromNumber, text)) {
          console.log('⏭️ Duplicate inbound webhook skipped (Meta format):', {
            messageId: inboundWaMessageId,
            phone: fromNumber,
          });
          await persistInboundCustomerMessage({
            messageObj,
            phone: fromNumber,
            text,
            projectId: resolvedProjectId,
            timestamp,
            waMessageId: inboundWaMessageId,
            userId: resolvedClientUserId,
          }).catch((err) => {
            console.error('Inbound persist on duplicate webhook failed (Meta):', err?.message || err);
          });
        } else {
        // Find or create contact first — flow reply must be immediate (before logging/opt-in).
        console.log('\n🔍 Searching for contact with phone:', fromNumber);
        let contact = await findContactByPhoneVariants(fromNumber, resolvedProjectId);

        const wasNewContact = !contact;
        const oldOptedOut = contact
          ? contact.status === 'unsubscribed' || !contact.whatsappOptInAt
          : false;

        let userId;

        if (contact) {
          userId = contact.userId;
          if (resolvedProjectId && !contact.projectId) {
            await contact.update({ projectId: resolvedProjectId });
          }
          console.log('✅ Existing contact found!');
          console.log('   Contact ID:', contact.id);
          console.log('   User ID:', userId);
          console.log('   Phone:', contact.phone);
          console.log('   Name:', contact.name);
          console.log('   Last Contacted:', contact.lastContacted);
        } else {
          console.log('⚠️ Contact not found, creating new one...');
          userId = await resolveInboundContactUserId(resolvedProjectId, resolvedClientUserId);

          if (!userId) {
            console.log('❌ ERROR: No active user found - cannot create contact');
            console.log('   Message will not be saved to inbox');
            return res.status(200).json({ success: true });
          }

          console.log('👤 Creating new contact with user (ID:', userId + ')');

          contact = await Contact.create({
            userId: userId,
            projectId: resolvedProjectId,
            phone: fromNumber,
            name: fromNumber,
            status: 'active'
          });
          console.log('✅ New contact created!');
          console.log('   Contact ID:', contact.id);
          console.log('   User ID:', userId);
        }

        contact = await reconcileContactProject(contact, resolvedProjectId);
        userId = userId || resolvedClientUserId || contact.userId;
        const inboundPhoneNumberId = extractInboundPhoneNumberId(payload, valueEntry);
        const flowProjectId = await resolveInboundFlowProjectId({
          phoneNumberId: inboundPhoneNumberId,
          wabaId: payload.entry?.[0]?.id || null,
          fallbackProjectId: resolvedProjectId || contact.projectId || null,
        });
        if (flowProjectId && flowProjectId !== resolvedProjectId) {
          resolvedProjectId = flowProjectId;
          contact = await reconcileContactProject(contact, flowProjectId);
        }
        const autoReplyProjectId = flowProjectId || resolvedProjectId || contact.projectId || null;

        logWebhook(
          'WEBHOOK_INBOUND_META',
          {
            customerPhone: fromNumber,
            inboundPhoneNumberId,
            flowProjectId,
            resolvedProjectId,
            autoReplyProjectId,
            messageType: messageObj.type,
            inboundText: text,
            replyCandidates,
          },
          null,
          { status: 'processing' }
        );

        let flowHandled = false;
        let flowResult = null;
        try {
          flowResult = await handleInboundFlowMessage({
            contact,
            userId,
            projectId: autoReplyProjectId,
            inboundText: text,
            replyCandidates,
            inboundPhone: fromNumber,
            inboundKind,
            inboundPhoneNumberId,
          });
          if (flowResult?.handled) {
            flowHandled = true;
            console.log('✅ Chatbot flow handled (immediate):', {
              flowId: flowResult.flowId,
              flowName: flowResult.flowName,
              matchSource: flowResult.matchSource,
              matchedText: flowResult.matchedText,
              sentCount: flowResult.sentCount,
              fromTemplateButton: flowResult.fromTemplateButton,
            });
            logWebhookFlowResult(
              {
                format: 'meta',
                projectId: autoReplyProjectId,
                customerPhone: fromNumber,
                inboundText: text,
              },
              {
                handled: true,
                ...pickFlowLogFields(flowResult),
              }
            );
          } else if (text) {
            console.log('ℹ️ No chatbot flow matched:', {
              projectId: autoReplyProjectId,
              contactProjectId: contact.projectId,
              resolvedProjectId,
              reason: flowResult?.reason,
              flowId: flowResult?.flowId,
              flowName: flowResult?.flowName,
              inboundText: text,
              messageType: messageObj.type,
            });
            logWebhookFlowResult(
              {
                format: 'meta',
                projectId: autoReplyProjectId,
                customerPhone: fromNumber,
                inboundText: text,
              },
              {
                handled: false,
                reason: flowResult?.reason || 'no_match',
                ...pickFlowLogFields(flowResult),
              }
            );
          }
        } catch (flowErr) {
          console.error('Flow inbound handler error:', flowErr?.message || flowErr);
          logWebhookFlowResult(
            {
              format: 'meta',
              projectId: autoReplyProjectId,
              customerPhone: fromNumber,
            },
            {
              handled: false,
              error: flowErr?.message || String(flowErr),
            }
          );
        }

        // Save to MetaMessage
        const metaMessage = await MetaMessage.create({
          phone: fromNumber,
          direction: 'inbound',
          message_type: messageObj.type || 'text',
          message_text: text || `[${messageObj.type || 'message'}]`,
          status: 'received',
          projectId: resolvedProjectId || null
        });
        console.log('✅ MetaMessage saved to DB (ID:', metaMessage.id + ')');

          // WhatsApp keyword consent handling:
          // - START/YES => opt-in
          // - STOP/UNSUBSCRIBE/CANCEL => opt-out
          const isOptOut = isWhatsappOptOutKeyword(text);

          if (isOptOut) {
            await contact.update({
              status: 'unsubscribed',
              whatsappOptInAt: null
            });
          } else if (
            wasNewContact ||
            isWhatsappOptInKeyword(text)
          ) {
            const optInUpdate = { status: 'active' };
            if (!contact.whatsappOptInAt) {
              optInUpdate.whatsappOptInAt = new Date();
              console.log('✅ Keyword opt-in: consent recorded (whatsappOptInAt set)');
            }
            await contact.update(optInUpdate);
          }

          // Auto-reply on first consent change:
          // - First message for new contact => send opt-in response
          // - STOP/UNSUBSCRIBE/CANCEL => send opt-out response (only if not already opted out)
          let billing = { allowed: true, wasNew: false };
          let billingAllowed = true;
          try {
            billing = await upsertConversationWithQuota(userId, fromNumber);
            billingAllowed = !!billing.allowed;
          } catch (billingErr) {
            // If billing tracking fails, don't break webhook processing.
            console.error('Conversation billing check failed (metaWebhookController):', billingErr?.message || billingErr);
          }

          try {
            if (
              billingAllowed &&
              !flowHandled &&
              !shouldSuppressConsentAutoReply(flowResult)
            ) {
              const sendAutoReply = async (replyBody) => {
                if (!autoReplyProjectId) {
                  await sendText(fromNumber, replyBody);
                  return;
                }
                const wcc = await requireWccForOutgoing(autoReplyProjectId, billing, {
                  isTemplate: false,
                  customerPhone: fromNumber,
                });
                if (!wcc.ok) {
                  console.log('Auto-reply skipped (insufficient WCC)');
                  return;
                }
                await sendText(fromNumber, replyBody);
                await debitWccAfterSuccessfulMetaSend(autoReplyProjectId, wcc.ownerUserId, billing, {
                  isTemplate: false,
                  customerPhone: fromNumber,
                });
              };
              if (isOptOut && !oldOptedOut) {
                await sendAutoReply(OPT_OUT_MESSAGE);
              }
            }
          } catch (e) {
            console.error('Auto reply sendText failed:', e?.message || e);
          }

          // Save message to Message table (for inbox compatibility)
          console.log('\n💾 Saving message to Message table...');
          const previewTextMeta = extractInboundPreviewText(messageObj) || text;

          const newMessage = await Message.create({
            contactId: contact.id,
            content: previewTextMeta,
            type: 'incoming',
            status: 'delivered',
            sentAt: timestamp,
            deliveredAt: timestamp
          });
          console.log('✅ Message saved to Message table! ID:', newMessage.id);

          // 🔹 CRITICAL: Also save to InboxMessage table (inbox fetches from here!)
          console.log('\n💾 Saving message to InboxMessage table...');
          let inboxMessage = null;
          try {
            const inboxData = buildInboxRecordFromWebhook(
              messageObj,
              contact,
              userId,
              contact.projectId || resolvedProjectId || null,
              timestamp,
              previewTextMeta
            );
            inboxMessage = await InboxMessage.create(inboxData);
            console.log('✅ Message saved to InboxMessage table! ID:', inboxMessage.id);
            const mediaId = extractMediaIdFromPayload(messageObj);
            if (mediaId) {
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
                  .catch((err) => console.warn('Inbound media cache failed:', err?.message || err));
              });
            }
          } catch (inboxError) {
            console.error('❌ Error saving to InboxMessage:', inboxError);
            // Don't fail the whole request if this fails
          }

          console.log('\n🔄 Updating contact lastContacted...');
          await contact.update({
            lastContacted: timestamp,
            lastCustomerMessageAt: timestamp,
          });
          console.log('✅ Contact lastContacted updated to:', timestamp.toISOString());

          // Sync to live-chat (conversations + message) so /live-chat and /inbox both show customer messages
          let conversationId = null;
          let agentId = null;
          try {
            const synced = await syncInboundToConversation({
              phone: fromNumber,
              text,
              projectId: resolvedProjectId,
              customerName: fromNumber,
              createdAt: timestamp,
            });
            conversationId = synced.conversationId;
            agentId = synced.agentId;
            console.log('✅ Synced incoming message to live-chat (conversation id:', conversationId + ', status:', synced.status + ')');
          } catch (syncErr) {
            console.error('Error syncing to live-chat:', syncErr);
          }

          // Emit real-time update (AiSensy-style routing)
          console.log('\n📡 Emitting Socket.IO events...');
          const normalizedInbound = normalizeWebhookMessage(messageObj, {
            direction: 'inbound',
            status: 'delivered',
            timestamp,
            from: fromNumber,
            waMessageId: messageObj?.id,
          });
          const messageId = inboxMessage?.id || newMessage.id;
          const previewText = extractInboundPreviewText(messageObj) || text;

          const messageData = buildSocketMessagePayload(normalizedInbound, {
            id: messageId,
            contactId: contact.id,
            conversationId,
            phone: fromNumber,
            content: previewText,
            sentAt: timestamp.toISOString(),
            createdAt: newMessage.createdAt ? newMessage.createdAt.toISOString() : timestamp.toISOString(),
          });

          const agentMessagePayload = {
            ...messageData,
            conversation_id: conversationId,
            message: previewText,
            direction: 'inbound',
            sender: 'customer',
            created_at: timestamp.toISOString(),
          };

          if (agentId) {
            // 2️⃣ Route to assigned agent live chat
            socketService.emitToAgent(agentId, 'new-message', agentMessagePayload);
            console.log(`   ✅ Emitted: new-message to agent_${agentId} (conversation ${conversationId || 'N/A'})`);
          } else {
            // 3️⃣ No agent assigned → manager inbox (list + open thread)
            socketService.emitToManager('new-message', agentMessagePayload);
            socketService.emitToManager('inbox-update', {
              contactId: contact.id,
              phone: fromNumber,
              lastMessage: previewText,
              lastMessageTime: timestamp,
            });
            console.log('   ✅ Emitted: new-message + inbox-update to manager (no agent assigned)');
          }

          console.log('\n✅ All processing complete for Meta/WhatsApp format');
          console.log('========================================\n');
        }
      }
    }

    // 🔹 3. Process AiSensy webhook format (event-based)
    // Skip when the same request already included Meta Cloud API message payload.
    if (payload.event === 'message_received' && !metaFormatInboundProcessed) {
      console.log('\n📱 Processing AiSensy format webhook');
      const phone = payload.from;
      const text = payload?.message?.text || '';

      console.log('📞 From Number:', phone);
      console.log('💬 Message Text:', text);

      if (phone) {
        const inboundWaMessageId =
          payload?.message_id ||
          payload?.message?.id ||
          payload?.id ||
          null;
        if (!claimInboundWebhookMessage(inboundWaMessageId, phone, text)) {
          console.log('⏭️ Duplicate inbound webhook skipped (AiSensy format):', {
            messageId: inboundWaMessageId,
            phone,
          });
          await persistInboundCustomerMessage({
            messageObj: payload?.message || { type: 'text', text: { body: text } },
            phone,
            text,
            projectId: resolvedProjectId,
            timestamp: new Date(),
            waMessageId: inboundWaMessageId,
            userId: resolvedClientUserId,
          }).catch((err) => {
            console.error('Inbound persist on duplicate webhook failed (AiSensy):', err?.message || err);
          });
        } else {
        console.log('\n🔍 Searching for contact with phone:', phone);
        let contact = await findContactByPhoneVariants(phone, resolvedProjectId);

        const wasNewContact = !contact;
        const oldOptedOut = contact
          ? contact.status === 'unsubscribed' || !contact.whatsappOptInAt
          : false;

        let userId;

        if (contact) {
          userId = contact.userId;
          if (resolvedProjectId && !contact.projectId) {
            await contact.update({ projectId: resolvedProjectId });
          }
          console.log('✅ Existing contact found!');
          console.log('   Contact ID:', contact.id);
          console.log('   User ID:', userId);
        } else {
          userId = await resolveInboundContactUserId(resolvedProjectId, resolvedClientUserId);

          if (!userId) {
            console.log('❌ ERROR: No active user found - cannot create contact');
            return res.status(200).json({ success: true });
          }

          contact = await Contact.create({
            userId: userId,
            projectId: resolvedProjectId,
            phone: phone,
            name: phone,
            status: 'active'
          });
        }

        contact = await reconcileContactProject(contact, resolvedProjectId);
        userId = userId || resolvedClientUserId || contact.userId;
        const aiInboundPhoneNumberId = extractInboundPhoneNumberId(payload);
        const flowProjectIdAi = await resolveInboundFlowProjectId({
          phoneNumberId: aiInboundPhoneNumberId,
          wabaId: payload?.waba_id || payload?.wabaId || null,
          fallbackProjectId: resolvedProjectId || contact.projectId || null,
        });
        if (flowProjectIdAi && flowProjectIdAi !== resolvedProjectId) {
          resolvedProjectId = flowProjectIdAi;
          contact = await reconcileContactProject(contact, flowProjectIdAi);
        }
        const autoReplyProjectIdAi = flowProjectIdAi || resolvedProjectId || contact.projectId || null;
        const replyCandidatesAi = extractInboundReplyCandidates(payload?.message || null);
        if (!replyCandidatesAi.length && text) replyCandidatesAi.push(text);
        const inboundKindAi = getInboundMessageKind(payload?.message || null);

        logWebhook(
          'WEBHOOK_INBOUND_AISENSY',
          {
            customerPhone: phone,
            aiInboundPhoneNumberId,
            flowProjectId: flowProjectIdAi,
            resolvedProjectId,
            autoReplyProjectId: autoReplyProjectIdAi,
            inboundText: text,
            replyCandidates: replyCandidatesAi,
          },
          null,
          { status: 'processing' }
        );

        let flowHandledAi = false;
        let flowResultAi = null;
        try {
          flowResultAi = await handleInboundFlowMessage({
            contact,
            userId,
            projectId: autoReplyProjectIdAi,
            inboundText: text,
            replyCandidates: replyCandidatesAi,
            inboundPhone: phone,
            inboundKind: inboundKindAi,
            inboundPhoneNumberId: aiInboundPhoneNumberId,
          });
          if (flowResultAi?.handled) {
            flowHandledAi = true;
            console.log('✅ Chatbot flow handled (AiSensy immediate):', {
              flowId: flowResultAi.flowId,
              matchedText: flowResultAi.matchedText,
              sentCount: flowResultAi.sentCount,
            });
            logWebhookFlowResult(
              {
                format: 'aisensy',
                projectId: autoReplyProjectIdAi,
                customerPhone: phone,
                inboundText: text,
              },
              {
                handled: true,
                ...pickFlowLogFields(flowResultAi),
              }
            );
          } else if (text) {
            logWebhookFlowResult(
              {
                format: 'aisensy',
                projectId: autoReplyProjectIdAi,
                customerPhone: phone,
                inboundText: text,
              },
              {
                handled: false,
                reason: flowResultAi?.reason || 'no_match',
                ...pickFlowLogFields(flowResultAi),
              }
            );
          }
        } catch (flowErr) {
          console.error('Flow inbound handler error (AiSensy):', flowErr?.message || flowErr);
          logWebhookFlowResult(
            {
              format: 'aisensy',
              projectId: autoReplyProjectIdAi,
              customerPhone: phone,
            },
            {
              handled: false,
              error: flowErr?.message || String(flowErr),
            }
          );
        }

        const metaMessage = await MetaMessage.create({
          phone,
          direction: 'inbound',
          message_type: 'text',
          message_text: text,
          status: 'received',
          projectId: resolvedProjectId || null
        });
        console.log('✅ MetaMessage saved to DB (ID:', metaMessage.id + ')');

          // WhatsApp keyword consent handling:
          // - START/YES => opt-in
          // - STOP/UNSUBSCRIBE/CANCEL => opt-out
          const isOptOut = isWhatsappOptOutKeyword(text);

          if (isOptOut) {
            await contact.update({
              status: 'unsubscribed',
              whatsappOptInAt: null
            });
          } else if (wasNewContact || isWhatsappOptInKeyword(text)) {
            const optInUpdateAi = { status: 'active' };
            if (!contact.whatsappOptInAt) {
              optInUpdateAi.whatsappOptInAt = new Date();
              console.log(
                '✅ Keyword opt-in (AiSensy): user sent "' +
                  String(text || '').trim() +
                  '" – consent recorded (whatsappOptInAt set)'
              );
            }
            await contact.update(optInUpdateAi);
          }

          // Auto-reply on first consent change:
          // - First message for new contact => send opt-in response
          // - STOP/UNSUBSCRIBE/CANCEL => send opt-out response (only if not already opted out)
          let billingAi = { allowed: true, wasNew: false };
          let billingAllowedAi = true;
          try {
            billingAi = await upsertConversationWithQuota(userId, phone);
            billingAllowedAi = !!billingAi.allowed;
          } catch (billingErr) {
            console.error('Conversation billing check failed (metaWebhookController AiSensy):', billingErr?.message || billingErr);
          }

          try {
            if (
              billingAllowedAi &&
              !flowHandledAi &&
              !shouldSuppressConsentAutoReply(flowResultAi)
            ) {
              const sendAutoReplyAi = async (replyBody) => {
                if (!autoReplyProjectIdAi) {
                  await sendText(phone, replyBody);
                  return;
                }
                const wcc = await requireWccForOutgoing(autoReplyProjectIdAi, billingAi, {
                  isTemplate: false,
                  customerPhone: phone,
                });
                if (!wcc.ok) {
                  console.log('Auto-reply skipped (insufficient WCC) [AiSensy]');
                  return;
                }
                await sendText(phone, replyBody);
                await debitWccAfterSuccessfulMetaSend(autoReplyProjectIdAi, wcc.ownerUserId, billingAi, {
                  isTemplate: false,
                  customerPhone: phone,
                });
              };
              if (isOptOut && !oldOptedOut) {
                await sendAutoReplyAi(OPT_OUT_MESSAGE);
              }
            }
          } catch (e) {
            console.error('Auto reply sendText failed (AiSensy):', e?.message || e);
          }

          // 🔹 4. Save message to Message table (for inbox compatibility)
          console.log('\n💾 Saving message to Message table...');
          const newMessage = await Message.create({
            contactId: contact.id,
            content: text,
            type: 'incoming',
            status: 'delivered', // Incoming messages are considered delivered
            sentAt: new Date(),
            deliveredAt: new Date()
          });
          console.log('✅ Message saved to Message table! ID:', newMessage.id);

          // 🔹 CRITICAL: Also save to InboxMessage table (inbox fetches from here!)
          console.log('\n💾 Saving message to InboxMessage table...');
          let inboxMessage = null;
          try {
            const aiMessageObj = payload?.message || { type: 'text', text: { body: text } };
            const inboxData = buildInboxRecordFromWebhook(
              aiMessageObj,
              contact,
              userId,
              contact.projectId || resolvedProjectId || null,
              new Date(),
              text
            );
            inboxMessage = await InboxMessage.create(inboxData);
            console.log('✅ Message saved to InboxMessage table! ID:', inboxMessage.id);
            const mediaId = extractMediaIdFromPayload(aiMessageObj);
            if (mediaId) {
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
                  .catch((err) => console.warn('Inbound media cache failed (AiSensy):', err?.message || err));
              });
            }
          } catch (inboxError) {
            console.error('❌ Error saving to InboxMessage:', inboxError);
            // Don't fail the whole request if this fails
          }

          // 🔹 5. Update contact's lastContacted
          console.log('\n🔄 Updating contact lastContacted...');
          const inboundAt = new Date();
          await contact.update({
            lastContacted: inboundAt,
            lastCustomerMessageAt: inboundAt,
          });
          console.log('✅ Contact lastContacted updated to:', inboundAt.toISOString());

          // Sync to live-chat (conversations + message) so /live-chat and /inbox both show customer messages
          let conversationId = null;
          let agentId = null;
          try {
            const synced = await syncInboundToConversation({
              phone,
              text,
              projectId: resolvedProjectId,
              customerName: phone,
              createdAt: newMessage.sentAt || new Date(),
            });
            conversationId = synced.conversationId;
            agentId = synced.agentId;
            console.log('✅ Synced incoming message to live-chat (conversation id:', conversationId + ', status:', synced.status + ')');
          } catch (syncErr) {
            console.error('Error syncing to live-chat:', syncErr);
          }

          // 🔹 6. Emit real-time update via Socket.IO (AiSensy-style routing)
          console.log('\n📡 Emitting Socket.IO events...');
          // Use InboxMessage ID if available, otherwise fall back to Message ID
          const messageId = inboxMessage?.id || newMessage.id;

          const inboundMsgObj = payload?.message || { type: 'text', text: { body: text } };
          const normalizedInboundAisensy = normalizeWebhookMessage(inboundMsgObj, {
            direction: 'inbound',
            status: 'delivered',
            timestamp: newMessage.sentAt || new Date(),
            from: phone,
            waMessageId: inboundWaMessageId,
          });
          const agentMessagePayload = buildSocketMessagePayload(normalizedInboundAisensy, {
            id: messageId,
            contactId: contact.id,
            conversationId,
            phone,
            content: extractInboundPreviewText(inboundMsgObj) || text,
            sentAt: newMessage.sentAt ? newMessage.sentAt.toISOString() : new Date().toISOString(),
            createdAt: newMessage.createdAt ? newMessage.createdAt.toISOString() : new Date().toISOString(),
          });
          agentMessagePayload.conversation_id = conversationId;
          agentMessagePayload.message = agentMessagePayload.content;

          const previewText = extractInboundPreviewText(inboundMsgObj) || text;

          if (agentId) {
            // 2️⃣ Route to assigned agent live chat
            socketService.emitToAgent(agentId, 'new-message', agentMessagePayload);
            console.log(`   ✅ Emitted: new-message to agent_${agentId} (conversation ${conversationId || 'N/A'})`);
          } else {
            // 3️⃣ No agent assigned → manager inbox
            socketService.emitToManager('new-message', agentMessagePayload);
            socketService.emitToManager('inbox-update', {
              contactId: contact.id,
              phone,
              lastMessage: previewText,
              lastMessageTime: newMessage.sentAt || new Date(),
            });
            console.log('   ✅ Emitted: new-message + inbox-update to manager (no agent assigned)');
          }

          console.log('\n✅ All processing complete for AiSensy format');
          console.log('========================================\n');
        }
      }
    }

    // 🔹 3. Handle message status updates (delivered, read)
    if (payload.event === 'message_delivered' || payload.event === 'message_read') {
      const messageId = payload.message_id || payload.id;
      const phone = payload.to || payload.recipient;

      if (phone && messageId) {
        // Find contact
        const firstUser = await User.findOne({
          where: { status: 'active' },
          order: [['id', 'ASC']]
        });

        if (firstUser) {
          const contact = await Contact.findOne({
            where: { phone, userId: firstUser.id },
            attributes: ['id', 'phone', 'name', 'email', 'status', 'tags', 'country', 'lastContacted', 'notes', 'userId', 'createdAt', 'updatedAt']
          });

          if (contact) {
            // Find message by external ID or phone + content match
            const message = await Message.findOne({
              where: {
                contactId: contact.id,
                type: 'outgoing',
                status: payload.event === 'message_delivered' ? 'sent' : { [Op.in]: ['sent', 'delivered'] }
              },
              order: [['sentAt', 'DESC']],
              limit: 1
            });

            if (message) {
              const updateData = {};
              if (payload.event === 'message_delivered') {
                updateData.status = 'delivered';
                updateData.deliveredAt = new Date();
              } else if (payload.event === 'message_read') {
                updateData.status = 'read';
                updateData.readAt = new Date();
              }

              await message.update(updateData);

              // Emit status update via Socket.IO
              socketService.emitToContact(contact.id, 'message-status-update', {
                messageId: message.id,
                status: updateData.status,
                deliveredAt: updateData.deliveredAt,
                readAt: updateData.readAt
              });
            }
          }
        }
      }
    }

    // 🔹 Always respond 200 to webhook
    console.log('\n✅ Webhook processed successfully - returning 200 OK');
    console.log('========================================\n');
    logWebhook(
      'WEBHOOK_DONE',
      {
        resolvedProjectId,
        resolvedClientUserId,
        ...webhookSummary,
      },
      null,
      { status: 200, success: true }
    );
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('\n========================================');
    console.error('❌ WEBHOOK ERROR:', error);
    console.error('Error Message:', error.message);
    console.error('Error Stack:', error.stack);
    console.error('========================================\n');
    logWebhook(
      'WEBHOOK_ERROR',
      { path: req.path || req.url },
      null,
      {
        message: error?.message || String(error),
        stack: error?.stack || null,
      }
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get webhook logs (for debugging)
exports.getWebhookLogs = async (req, res) => {
  try {
    const { limit = 50, event_type, phone } = req.query;

    const where = {};
    if (event_type) {
      where.event_type = event_type;
    }

    // Use a very high limit or no limit if limit is very high
    const queryLimit = parseInt(limit) >= 1000 ? null : parseInt(limit);
    let logs = await WebhookLog.findAll({
      where,
      limit: queryLimit, // null means no limit
      order: [['created_at', 'DESC']],
      attributes: ['id', 'event_type', 'payload', 'created_at']
    });

    // Filter by phone if provided (search in payload)
    if (phone) {
      const normalizedPhone = phone.replace(/\D/g, '');
      logs = logs.filter(log => {
        try {
          const payload = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
          // Check various phone fields in payload
          const fromNumber = payload.from || payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || 
                            payload.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id;
          if (fromNumber) {
            const normalizedFrom = String(fromNumber).replace(/\D/g, '');
            return normalizedFrom === normalizedPhone || normalizedFrom.endsWith(normalizedPhone) || normalizedPhone.endsWith(normalizedFrom);
          }
          return false;
        } catch (e) {
          return false;
        }
      });
    }

    res.json({
      success: true,
      count: logs.length,
      logs: logs.map(log => {
        try {
          return {
            id: log.id,
            event_type: log.event_type,
            payload: typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload,
            received_at: log.created_at,
            created_at: log.created_at
          };
        } catch (e) {
          return {
            id: log.id,
            event_type: log.event_type,
            payload: {},
            received_at: log.created_at,
            created_at: log.created_at
          };
        }
      })
    });
  } catch (err) {
    console.error('Get Webhook Logs Error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to get webhook logs'
    });
  }
};