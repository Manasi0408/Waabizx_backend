const { Op } = require('sequelize');
const { Template, Contact, InboxMessage, Message, MetaMessage } = require('../models');
const Project = require('../models/Project');
const {
  normalizeMetaTemplateName,
  resolveTemplateComponentsForSend,
  fetchMetaTemplateByName,
  fetchAllMetaMessageTemplates,
  resolveMetaCredentialsForProject,
} = require('./metaTemplateFetchService');
const {
  getTemplateComponents,
  parseTemplateSendSpec,
  buildWhatsAppTemplateComponents,
  extractDynamicUrlButtonComponents,
  resolveDisplayableHeaderMediaUrl,
  resolveHeaderImageFromComponents,
  toPublicMediaUrl,
} = require('../utils/templateMessageComponents');
const {
  buildClientTemplatePreview,
  enrichTemplateRecordWithComponents,
  finalizeTemplateSnapshotForInbox,
} = require('../utils/templatePreviewUtil');
const {
  postWhatsAppMessage,
  isSessionWindowClosedError,
} = require('../utils/metaWhatsAppCredentials');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');
const { resolveHeaderMediaIdForSend } = require('./templateHeaderSendService');
const socketService = require('./socketService');
const { debitWccAfterSuccessfulMetaSend } = require('./wccMetaChargeService');

const SESSION_MS = 24 * 60 * 60 * 1000;

function extractVariableNums(text) {
  const matches = String(text || '').match(/\{\{(\d+)\}\}/g) || [];
  return [...new Set(matches.map((m) => parseInt(m.replace(/[{}]/g, ''), 10)))]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function normalizePhoneDigits(value) {
  return String(value || '').trim().replace(/^\+/, '').replace(/\D/g, '');
}

function buildPhoneSearchVariants(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return [];
  const set = new Set([digits, `+${digits}`]);
  if (digits.length === 10) {
    set.add(`91${digits}`);
    set.add(`+91${digits}`);
  }
  if (digits.startsWith('91') && digits.length === 12) {
    set.add(digits.slice(2));
    set.add(`+${digits.slice(2)}`);
  }
  return [...set].filter(Boolean);
}

function metaTemplateToSendRecord(metaTpl) {
  if (!metaTpl?.name) return null;
  const components = Array.isArray(metaTpl.components) ? metaTpl.components : [];
  const body = components.find((c) => String(c.type || '').toUpperCase() === 'BODY');
  return {
    name: metaTpl.name,
    content: body?.text || `Template: ${metaTpl.name}`,
    status: 'approved',
    metaStatus: 'APPROVED',
    metaTemplateId: metaTpl.id ? String(metaTpl.id) : null,
    category: String(metaTpl.category || 'UTILITY').toLowerCase(),
    components,
    variables: {
      components,
      language: metaTpl.language || 'en_US',
      metaCategory: metaTpl.category,
    },
  };
}

function pickBestMetaTemplate(metaTemplates, preferredNames = []) {
  const approved = (metaTemplates || []).filter(
    (t) => String(t.status || '').toUpperCase() === 'APPROVED'
  );
  if (!approved.length) return null;

  for (const pref of preferredNames) {
    const normalized = normalizeMetaTemplateName(pref);
    const hit = approved.find((t) => normalizeMetaTemplateName(t.name) === normalized);
    if (hit && !metaTemplateNeedsUnavailableHeaderMedia(hit)) return hit;
  }

  const utilityFirst = approved.filter((t) => {
    const cat = String(t.category || '').toUpperCase();
    return cat === 'UTILITY' || cat === 'AUTHENTICATION';
  });

  for (const list of [utilityFirst, approved]) {
    for (const tpl of list) {
      if (!metaTemplateNeedsUnavailableHeaderMedia(tpl)) return tpl;
    }
  }

  return approved[0] || null;
}

function metaTemplateNeedsUnavailableHeaderMedia(metaTpl) {
  const record = metaTemplateToSendRecord(metaTpl);
  return record ? templateNeedsUnavailableHeaderMedia(record) : true;
}

/**
 * WhatsApp customer service window is open when the user sent an inbound message within 24h.
 */
async function hasOpenCustomerServiceWindow({ projectId, contactId, phone }) {
  try {
    const since = new Date(Date.now() - SESSION_MS);
    const pid = Number(projectId);
    const variants = buildPhoneSearchVariants(phone);

    let contactIds = [];
    if (Number.isInteger(pid) && pid > 0) {
      const cid = Number(contactId);
      if (Number.isInteger(cid) && cid > 0) contactIds.push(cid);

      if (variants.length) {
        const relatedContacts = await Contact.findAll({
          where: { projectId: pid, phone: { [Op.in]: variants } },
          attributes: ['id'],
        });
        contactIds = [...new Set([...contactIds, ...relatedContacts.map((c) => c.id)])];
      }
    }

    if (contactIds.length && Number.isInteger(pid) && pid > 0) {
      const inboundInbox = await InboxMessage.findOne({
        where: {
          projectId: pid,
          contactId: { [Op.in]: contactIds },
          direction: 'incoming',
          timestamp: { [Op.gte]: since },
        },
        order: [['timestamp', 'DESC']],
      });
      if (inboundInbox) return true;

      const inboundMsg = await Message.findOne({
        where: {
          projectId: pid,
          contactId: { [Op.in]: contactIds },
          type: 'incoming',
          sentAt: { [Op.gte]: since },
        },
        order: [['sentAt', 'DESC']],
      });
      if (inboundMsg) return true;
    }

    if (variants.length && Number.isInteger(pid) && pid > 0) {
      const metaInbound = await MetaMessage.findOne({
        where: {
          projectId: pid,
          phone: { [Op.in]: variants },
          direction: 'inbound',
          createdAt: { [Op.gte]: since },
        },
        order: [['createdAt', 'DESC']],
      });
      if (metaInbound) return true;
    }

    return false;
  } catch (err) {
    console.warn('[session-window] check failed, assuming open (will try text first):', err?.message || err);
    return true;
  }
}

async function resolveReengagementTemplate({ userId, projectId }) {
  const ownerId = await Project.getProjectOwnerId(projectId);
  const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0 || !userIds.length) return null;

  const preferredNames = [
    process.env.DEFAULT_REENGAGEMENT_TEMPLATE,
    process.env.DEFAULT_UTILITY_TEMPLATE,
    'hello_world',
  ].filter(Boolean);

  const approvedWhere = {
    projectId: pid,
    userId: { [Op.in]: userIds },
    [Op.or]: [{ status: 'approved' }, { metaStatus: 'APPROVED' }],
  };

  for (const envName of preferredNames) {
    const names = [...new Set([envName, normalizeMetaTemplateName(envName)])];
    const record = await Template.findOne({ where: { ...approvedWhere, name: { [Op.in]: names } } });
    if (record && !templateNeedsUnavailableHeaderMedia(record)) return record;
  }

  const candidates = await Template.findAll({
    where: approvedWhere,
    order: [['id', 'DESC']],
    limit: 80,
  });

  const utilityFirst = candidates.filter((t) => {
    const cat = String(t.category || '').toLowerCase();
    return ['utility', 'transactional', 'notification', 'welcome', 'service'].includes(cat);
  });

  for (const list of [utilityFirst, candidates]) {
    for (const record of list) {
      if (!templateNeedsUnavailableHeaderMedia(record)) return record;
    }
  }

  try {
    const { wabaId, token } = await resolveMetaCredentialsForProject(userId, projectId);
    if (wabaId && token) {
      const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
      const metaTemplates = await fetchAllMetaMessageTemplates(wabaId, token, apiVersion);
      const picked = pickBestMetaTemplate(metaTemplates, preferredNames);
      if (picked) {
        console.log('[re-engagement] Using Meta-approved template:', picked.name);
        return metaTemplateToSendRecord(picked);
      }
    }
  } catch (metaErr) {
    console.warn('[re-engagement] Meta template list lookup failed:', metaErr?.message || metaErr);
  }

  return null;
}

function templateNeedsUnavailableHeaderMedia(templateRecord) {
  const comps = getTemplateComponents(templateRecord);
  const spec = parseTemplateSendSpec(comps, templateRecord?.content || '');
  if (!spec?.needsHeaderMedia) return false;
  const headerUrl = resolveDisplayableHeaderMediaUrl(
    resolveHeaderImageFromComponents(comps),
    templateRecord?.variables?.headerMediaUrl,
    templateRecord?.variables?.headerImageUrl,
    templateRecord?.variables?.header_image_url
  );
  return !toPublicMediaUrl(headerUrl);
}

function buildAudienceFromMessageText(bodyVarNums, messageText) {
  const audienceMember = {};
  if (!bodyVarNums?.length) return audienceMember;
  audienceMember[`var${bodyVarNums[0]}`] = String(messageText || '').slice(0, 1024);
  bodyVarNums.slice(1).forEach((n) => {
    audienceMember[`var${n}`] = '';
  });
  return audienceMember;
}

async function buildReengagementTemplatePayload({
  userId,
  projectId,
  phone,
  messageText,
  templateRecord,
  waCandidates,
}) {
  const metaTemplateName = normalizeMetaTemplateName(templateRecord.name);
  const templateContent = templateRecord.content || '';
  const resolvedComponents = await resolveTemplateComponentsForSend(templateRecord, {
    userId,
    projectId,
    templateName: metaTemplateName,
  });
  const sendSpec = parseTemplateSendSpec(resolvedComponents, templateContent);
  const bodyVarNums =
    sendSpec?.bodyVarNums?.length > 0 ? sendSpec.bodyVarNums : extractVariableNums(templateContent);
  const audienceMember = buildAudienceFromMessageText(bodyVarNums, messageText);

  let headerMediaUrl = resolveDisplayableHeaderMediaUrl(
    resolveHeaderImageFromComponents(resolvedComponents),
    templateRecord?.variables?.headerMediaUrl,
    templateRecord?.variables?.headerImageUrl
  );

  let headerMediaId = null;
  let headerMediaPhoneId = null;
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
      throw new Error(
        `Re-engagement template "${metaTemplateName}" requires header media. Set DEFAULT_REENGAGEMENT_TEMPLATE to a text-only utility template.`
      );
    }
  }

  let resolvedLanguage = 'en_US';
  try {
    const metaTpl = await fetchMetaTemplateByName(metaTemplateName, userId, projectId);
    if (metaTpl?.language) resolvedLanguage = String(metaTpl.language);
  } catch (_) {
    /* use default */
  }

  const templatePayload = {
    messaging_product: 'whatsapp',
    to: normalizeWhatsAppRecipient(phone) || phone,
    type: 'template',
    template: {
      name: metaTemplateName,
      language: { code: resolvedLanguage },
    },
  };

  const paramsArray = bodyVarNums.map((n) => audienceMember[`var${n}`] ?? '');
  let waTemplateComponents = buildWhatsAppTemplateComponents({
    sendSpec,
    headerMediaUrl,
    headerMediaId,
    audienceMember,
  });
  const buttonComponents = extractDynamicUrlButtonComponents(resolvedComponents, audienceMember);
  if (buttonComponents.length) {
    waTemplateComponents = [...(waTemplateComponents || []), ...buttonComponents];
  }

  if (waTemplateComponents?.length) {
    templatePayload.template.components = waTemplateComponents;
  } else if (paramsArray.length > 0) {
    templatePayload.template.components = [
      {
        type: 'BODY',
        parameters: paramsArray.map((param) => ({
          type: 'text',
          text: typeof param === 'string' ? param : String(param),
        })),
      },
    ];
  }

  const clientPreview = buildClientTemplatePreview(
    enrichTemplateRecordWithComponents(templateRecord, resolvedComponents),
    templateContent,
    {
      templateName: metaTemplateName,
      templateParams: paramsArray,
      headerImageUrl: headerMediaUrl,
    }
  );
  const snapshotForInbox = finalizeTemplateSnapshotForInbox(
    clientPreview,
    templatePayload,
    headerMediaUrl
  );

  return {
    metaTemplateName,
    templateContent,
    templatePayload,
    snapshotForInbox,
    resolvedComponents,
    headerMediaPhoneId,
  };
}

async function sendReengagementTemplateMessage({
  userId,
  projectId,
  phone,
  messageText,
  waCandidates,
}) {
  let templateRecord = await resolveReengagementTemplate({ userId, projectId });

  if (!templateRecord) {
    console.log('[re-engagement] No approved template found — trying hello_world fallback');
    templateRecord = {
      name: 'hello_world',
      content: 'Hello World',
      status: 'approved',
      metaStatus: 'APPROVED',
      category: 'utility',
      variables: { language: 'en_US' },
    };
  }

  try {
    const built = await buildReengagementTemplatePayload({
      userId,
      projectId,
      phone,
      messageText,
      templateRecord,
      waCandidates,
    });

    const sent = await postWhatsAppMessage(waCandidates, built.templatePayload, {
      userId,
      projectId,
      preferredPhoneNumberId: built.headerMediaPhoneId || undefined,
      preferDirectApi:
        String(process.env.INBOX_SEND_VIA_DIRECT_API ?? 'true').trim().toLowerCase() !== 'false',
      graphOnly: false,
    });
    const wamid = sent.response?.data?.messages?.[0]?.id || null;
    if (!wamid) {
      throw new Error('WhatsApp API did not return a message id for re-engagement template');
    }

    return {
      success: true,
      wamid,
      messageId: wamid,
      templateName: built.metaTemplateName,
      templateRecord,
      templateContent: built.templateContent,
      snapshotForInbox: built.snapshotForInbox,
      response: sent.response?.data,
    };
  } catch (primaryErr) {
    if (normalizeMetaTemplateName(templateRecord?.name) === 'hello_world') {
      throw primaryErr;
    }
    console.warn('[re-engagement] Primary template failed, trying hello_world:', primaryErr?.message || primaryErr);
    const fallbackRecord = {
      name: 'hello_world',
      content: 'Hello World',
      status: 'approved',
      metaStatus: 'APPROVED',
      category: 'utility',
      variables: { language: 'en_US' },
    };
    const built = await buildReengagementTemplatePayload({
      userId,
      projectId,
      phone,
      messageText: '',
      templateRecord: fallbackRecord,
      waCandidates,
    });
    const sent = await postWhatsAppMessage(waCandidates, built.templatePayload, {
      userId,
      projectId,
      preferredPhoneNumberId: built.headerMediaPhoneId || undefined,
      preferDirectApi:
        String(process.env.INBOX_SEND_VIA_DIRECT_API ?? 'true').trim().toLowerCase() !== 'false',
      graphOnly: false,
    });
    const wamid = sent.response?.data?.messages?.[0]?.id || null;
    if (!wamid) throw primaryErr;
    return {
      success: true,
      wamid,
      messageId: wamid,
      templateName: 'hello_world',
      templateRecord: fallbackRecord,
      templateContent: built.templateContent,
      snapshotForInbox: built.snapshotForInbox,
      response: sent.response?.data,
    };
  }
}

/**
 * Webhook path: text was accepted then failed as "Re-engagement message" — auto-resend as template.
 */
async function retryInboxMessageAsReengagementTemplate(inboxMsg, failMsg) {
  if (!inboxMsg || inboxMsg.direction !== 'outgoing') return { ok: false, reason: 'not_outgoing' };
  if (inboxMsg.isTemplateSend) return { ok: false, reason: 'already_template' };

  let priorPayload = {};
  try {
    priorPayload = inboxMsg.payload ? JSON.parse(inboxMsg.payload) : {};
  } catch (_) {
    priorPayload = {};
  }
  if (priorPayload.reengagementRetried) return { ok: false, reason: 'already_retried' };
  if (!isSessionWindowClosedError(failMsg)) return { ok: false, reason: 'not_session_error' };

  const contact = await Contact.findByPk(inboxMsg.contactId);
  if (!contact?.phone) return { ok: false, reason: 'no_contact' };

  const userId = inboxMsg.userId;
  const projectId = inboxMsg.projectId;
  const messageText = String(inboxMsg.message || '').trim();
  if (!messageText) return { ok: false, reason: 'empty_message' };

  const { resolveWhatsAppSendCredentialCandidates } = require('../utils/metaWhatsAppCredentials');
  const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
  if (!waCandidates.length) return { ok: false, reason: 'no_credentials' };

  let sendResult;
  try {
    sendResult = await sendReengagementTemplateMessage({
      userId,
      projectId,
      phone: contact.phone,
      messageText,
      waCandidates,
    });
  } catch (err) {
    console.error('[re-engagement] Auto template retry failed:', err?.message || err);
    return { ok: false, reason: 'send_failed', error: err?.message || String(err) };
  }

  const snapshot = sendResult.snapshotForInbox;
  await inboxMsg.update({
    status: 'sent',
    waMessageId: sendResult.wamid,
    isTemplateSend: true,
    templateName: sendResult.templateName,
    templateSnapshot: snapshot ? JSON.stringify(snapshot) : null,
    mediaUrl: snapshot?.headerImageUrl || snapshot?.header?.url || null,
    message: snapshot?.body || messageText,
    payload: JSON.stringify({
      ...priorPayload,
      reengagementRetried: true,
      reengagementOriginalError: failMsg,
      sentViaTemplate: true,
    }),
  });

  try {
    await Message.update(
      { status: 'sent', errorMessage: null },
      {
        where: {
          contactId: contact.id,
          projectId,
          content: messageText,
          type: 'outgoing',
        },
      }
    );
  } catch (_) {
    /* best effort */
  }

  try {
    const ownerUserId = await Project.getProjectOwnerId(projectId);
    await debitWccAfterSuccessfulMetaSend(projectId, ownerUserId, { wasNew: false }, {
      isTemplate: true,
      customerPhone: contact.phone,
    });
  } catch (wccErr) {
    console.warn('[re-engagement] WCC debit after retry:', wccErr?.message || wccErr);
  }

  const statusPayload = {
    messageId: inboxMsg.id,
    waMessageId: sendResult.wamid,
    status: 'sent',
    errorMessage: null,
    sentViaTemplate: true,
    templateName: sendResult.templateName,
  };
  if (inboxMsg.contactId) {
    socketService.emitToContact(inboxMsg.contactId, 'message-status-update', statusPayload);
  }
  if (inboxMsg.userId) {
    socketService.emitToUser(inboxMsg.userId, 'message-status-update', statusPayload);
  }

  console.log('[re-engagement] Auto-sent template after webhook failure:', {
    inboxMessageId: inboxMsg.id,
    template: sendResult.templateName,
    wamid: sendResult.wamid,
  });

  return { ok: true, wamid: sendResult.wamid, templateName: sendResult.templateName };
}

module.exports = {
  hasOpenCustomerServiceWindow,
  resolveReengagementTemplate,
  sendReengagementTemplateMessage,
  retryInboxMessageAsReengagementTemplate,
  isSessionWindowClosedError,
};
