const { Flow, Template, InboxMessage, User, Campaign, CampaignAudience, Contact } = require('../models');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const {
  resolveWhatsAppSendCredentialCandidates,
  postWhatsAppMessage,
} = require('../utils/metaWhatsAppCredentials');
const { normalizeWhatsAppRecipient, phoneVariantsForLookup } = require('../utils/phoneNormalize');
const { logWebhook } = require('../utils/webhookLogger');
const {
  parseTemplateSendSpec,
  buildWhatsAppTemplateComponents,
  buildBodyParamsFromAudience,
  extractButtonsFromComponents,
  extractDynamicUrlButtonComponents,
  normalizeFlowButtons,
  metaTemplateHasButtons,
  toPublicMediaUrl,
  toPermanentUploadPath,
  getTemplateComponents,
} = require('../utils/templateMessageComponents');
const {
  buildClientTemplatePreview,
  finalizeTemplateSnapshotForInbox,
  resolveHeaderFromCampaign,
} = require('../utils/templatePreviewUtil');
const { uploadTemplateHeaderMediaId, resolveLocalMediaPath } = require('./templateHeaderSendService');
const {
  normalizeMetaTemplateName,
  resolveTemplateForFlow,
  loadTemplateRecordForCampaign,
} = require('../services/metaTemplateFetchService');
const tagService = require('./tagService');
const {
  runFlow,
  parseFlowData,
  matchesStartTrigger,
  findStartNodeId,
  getTemplateButtonsFromNodeData,
  findFlowWaitNodeByButtonReply,
  resolveFlowResumeFromButtonReply,
  isFlowButtonWaitNode,
  buttonsMatch,
} = require('./flowExecutionService');
const {
  getFlowSession,
  saveFlowSession,
  clearFlowSession,
  findContactWithFlowSession,
} = require('./flowSessionService');
const { upsertConversationWithQuota } = require('./conversationBillingService');
const { sendText } = require('./whatsappService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('./wccMetaChargeService');
const { flowMessagePayloadResponse, logApiFailure } = require('../utils/logger');
const socketService = require('./socketService');
const { mapMessageTypeToInboxEnum } = require('../utils/waMessageNormalizer');

function resolvePublicMediaUrl(url) {
  return toPublicMediaUrl(url) || String(url || '').trim();
}

function templateBodyFallbackText(step) {
  const parts = step?.templateParts;
  const chunks = [
    parts?.headerText,
    parts?.body || step?.templateContent,
    parts?.footer,
  ].filter(Boolean);
  return chunks.join('\n\n').trim();
}

function resolveFlowCustomerDisplayName(contact, phone) {
  const phoneNorm = String(phone || contact?.phone || '').trim();
  const raw = String(contact?.name || '').trim();
  if (!raw) return 'Customer';
  if (phoneNorm && raw.replace(/\D/g, '') === phoneNorm.replace(/\D/g, '')) return 'Customer';
  return raw;
}

function extractFlowTemplateBodyVarNums(sendSpec, templateContent) {
  const fromSpec = sendSpec?.bodyVarNums || [];
  if (fromSpec.length) return fromSpec;
  const matches = String(templateContent || '').match(/\{\{(\d+)\}\}/g) || [];
  const nums = [...new Set(matches.map((m) => parseInt(m.replace(/[{}]/g, ''), 10)))]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return nums.length ? nums : /\{\{\s*1\s*\}\}/.test(String(templateContent || '')) ? [1] : [];
}

function buildFlowAudienceMember({ contact, phone, bodyVarNums }) {
  const audienceMember = {};
  const displayName = resolveFlowCustomerDisplayName(contact, phone);
  (bodyVarNums || []).forEach((n, idx) => {
    audienceMember[`var${n}`] = idx === 0 ? displayName : '';
  });
  if (!Object.keys(audienceMember).length && displayName) {
    audienceMember.var1 = displayName;
  }
  return audienceMember;
}

function buildFlowTemplateWaComponents({
  sendSpec,
  bodyVarNums,
  headerMediaUrl,
  headerMediaId,
  audienceMember,
}) {
  const spec = { ...(sendSpec || {}), bodyVarNums: bodyVarNums || [] };
  try {
    if (!spec.needsHeaderMedia || headerMediaUrl || headerMediaId) {
      return buildWhatsAppTemplateComponents({
        sendSpec: spec,
        headerMediaUrl,
        headerMediaId,
        audienceMember,
      });
    }
  } catch (headerErr) {
    console.warn('Flow template header components skipped:', headerErr?.message || headerErr);
  }
  if (!spec.bodyVarNums?.length) return undefined;
  const bodyParams = buildBodyParamsFromAudience(spec.bodyVarNums, audienceMember || {});
  return [
    {
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text })),
    },
  ];
}

function personalizeFlowMessageText(text, contact, phone) {
  const name = resolveFlowCustomerDisplayName(contact, phone);
  let out = String(text || '');
  const rules = [
    [/\{\{1\}\}/g, name],
    [/\{\{\s*1\s*\}\}/gi, name],
    [/\{\{\s*name\s*\}\}/gi, name],
    [/\{name\}/gi, name],
    [/%name%/gi, name],
    [/\[name\]/gi, name],
    [/DEAR VALUED CUSTOMER/gi, name],
  ];
  rules.forEach(([pattern, value]) => {
    out = out.replace(pattern, value);
  });
  return out;
}

function buildStoredMessagePayload(graphPayload, messageId) {
  const type = String(graphPayload?.type || 'text').toLowerCase();
  const stored = { type, id: messageId || null };
  if (graphPayload?.[type]) stored[type] = graphPayload[type];
  if (graphPayload?.interactive) stored.interactive = graphPayload.interactive;
  if (graphPayload?.text) stored.text = graphPayload.text;
  if (graphPayload?.template) stored.template = graphPayload.template;
  return stored;
}

function displayTextFromGraphPayload(graphPayload) {
  const type = String(graphPayload?.type || '').toLowerCase();
  if (type === 'text') return String(graphPayload.text?.body || '').trim();
  if (type === 'image') return String(graphPayload.image?.caption || '').trim();
  if (type === 'video') return String(graphPayload.video?.caption || '').trim();
  if (type === 'document') {
    return String(graphPayload.document?.caption || graphPayload.document?.filename || '').trim();
  }
  if (type === 'interactive') return String(graphPayload.interactive?.body?.text || '').trim();
  return '';
}

function mediaUrlFromGraphPayload(graphPayload) {
  const type = String(graphPayload?.type || '').toLowerCase();
  if (type === 'image') return resolvePublicMediaUrl(graphPayload.image?.link);
  if (type === 'video') return resolvePublicMediaUrl(graphPayload.video?.link);
  if (type === 'document') return resolvePublicMediaUrl(graphPayload.document?.link);
  if (type === 'interactive' && graphPayload.interactive?.header) {
    const headerType = String(graphPayload.interactive.header.type || '').toLowerCase();
    if (headerType === 'image') {
      return resolvePublicMediaUrl(graphPayload.interactive.header.image?.link);
    }
    if (headerType === 'video') {
      return resolvePublicMediaUrl(graphPayload.interactive.header.video?.link);
    }
  }
  return null;
}

function queueFlowInboxSave(saveFn) {
  setImmediate(() => {
    Promise.resolve()
      .then(saveFn)
      .catch((e) => console.warn('Flow inbox save failed:', e?.message || e));
  });
}

function queueFlowSessionSave(saveFn) {
  setImmediate(() => {
    Promise.resolve()
      .then(saveFn)
      .catch((e) => console.warn('Flow session save failed:', e?.message || e));
  });
}

/** Reuse credentials + billing for all steps in one flow dispatch. */
let activeFlowSendCredentialCache = null;
let activeFlowDispatchContext = null;

function isFlowFastDispatch() {
  return Boolean(activeFlowDispatchContext);
}

let activeFlowTemplateRecordCache = null;

function flowTemplateCacheKey(userId, projectId, templateName) {
  return `${userId}|${projectId}|${normalizeMetaTemplateName(templateName)}`;
}

async function loadTemplateRecordForFlowCached({ userId, projectId, templateName }) {
  const key = flowTemplateCacheKey(userId, projectId, templateName);
  if (activeFlowTemplateRecordCache?.has(key)) {
    return activeFlowTemplateRecordCache.get(key);
  }
  const record = await loadTemplateRecordForFlow({ userId, projectId, templateName });
  if (activeFlowTemplateRecordCache) {
    activeFlowTemplateRecordCache.set(key, record);
  }
  return record;
}

async function saveFlowOutboxInboxMessage({
  contactId,
  userId,
  projectId,
  phone,
  graphPayload,
  messageId,
  templateExtras = null,
}) {
  if (!contactId || !graphPayload) return null;

  const storedPayload = buildStoredMessagePayload(graphPayload, messageId);
  const displayText = displayTextFromGraphPayload(graphPayload);
  const mediaUrl = mediaUrlFromGraphPayload(graphPayload);
  const inboxType = mapMessageTypeToInboxEnum(storedPayload.type);

  try {
    const row = await InboxMessage.create({
      contactId,
      userId,
      projectId,
      direction: 'outgoing',
      message:
        templateExtras?.message ||
        displayText ||
        (mediaUrl ? `[${inboxType}]` : '(message)'),
      type: inboxType,
      status: 'sent',
      waMessageId: messageId || null,
      mediaUrl: templateExtras?.mediaUrl || mediaUrl || null,
      payload: JSON.stringify(storedPayload),
      isTemplateSend: Boolean(templateExtras?.isTemplateSend),
      templateName: templateExtras?.templateName || null,
      templateSnapshot: templateExtras?.templateSnapshot || null,
      timestamp: new Date(),
    });

    const socketPayload = {
      id: row.id,
      contactId,
      phone: phone || null,
      content: row.message,
      type: 'outgoing',
      messageType: templateExtras?.isTemplateSend ? 'template' : storedPayload.type,
      status: 'sent',
      sentAt: row.timestamp ? row.timestamp.toISOString() : new Date().toISOString(),
      createdAt: row.createdAt ? row.createdAt.toISOString() : new Date().toISOString(),
      waMessageId: messageId || null,
      mediaUrl: row.mediaUrl,
      payload: storedPayload,
      interactive: storedPayload.interactive || null,
      isTemplate: Boolean(templateExtras?.isTemplateSend),
      isTemplateSend: Boolean(templateExtras?.isTemplateSend),
      templateName: templateExtras?.templateName || null,
      templatePreview: templateExtras?.templatePreview || null,
      source: 'flow_outbox',
    };

    try {
      socketService.emitToContact(contactId, 'new-message', socketPayload);
      if (userId) socketService.emitToUser(userId, 'inbox-update', { contactId });
    } catch (socketErr) {
      console.warn('Flow outbox socket emit failed:', socketErr?.message || socketErr);
    }

    return row;
  } catch (e) {
    console.warn('Flow outbox inbox save failed:', e?.message || e);
    return null;
  }
}

function guessMediaFilename(url, typeKey) {
  const base = path.basename(String(url || '').split('?')[0]) || '';
  if (base.includes('.')) return base;
  if (typeKey === 'video') return 'video.mp4';
  if (typeKey === 'image') return 'image.jpg';
  return 'document.pdf';
}

function mimeTypeForMedia(typeKey, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (typeKey === 'image') {
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
  }
  if (typeKey === 'video') {
    if (ext === '.3gp' || ext === '.3gpp') return 'video/3gpp';
    return 'video/mp4';
  }
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function readMediaBuffer(publicUrl) {
  const candidates = [
    publicUrl,
    toPermanentUploadPath(publicUrl),
    toPublicMediaUrl(publicUrl),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const localPath = resolveLocalMediaPath(candidate);
    if (localPath) {
      return {
        buffer: fs.readFileSync(localPath),
        filename: path.basename(localPath),
      };
    }
  }

  const fetchUrl = toPublicMediaUrl(publicUrl) || publicUrl;
  if (!fetchUrl || !/^https?:\/\//i.test(String(fetchUrl))) {
    throw new Error('Media file not found on disk and no public URL available');
  }

  const res = await axios.get(fetchUrl, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`Media download failed (${res.status})`);
  }
  return {
    buffer: Buffer.from(res.data),
    filename: guessMediaFilename(fetchUrl, 'file'),
  };
}

async function uploadFlowMediaFromBuffer(creds, buffer, filename, format = 'IMAGE') {
  if (!creds?.phoneNumberId || !creds?.accessToken || !buffer?.length) return null;
  const typeKey =
    String(format || 'IMAGE').toUpperCase() === 'VIDEO'
      ? 'video'
      : String(format || 'IMAGE').toUpperCase() === 'DOCUMENT'
        ? 'document'
        : 'image';
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', typeKey);
    form.append('file', buffer, {
      filename: filename || guessMediaFilename('', typeKey),
      contentType: mimeTypeForMedia(typeKey, filename),
    });
    const apiVersion = creds.apiVersion || process.env.WHATSAPP_API_VERSION || 'v22.0';
    const uploadUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}/media`;
    const res = await axios.post(uploadUrl, form, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, ...form.getHeaders() },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      console.warn('[flow] media buffer upload failed:', res.status, res.data?.error?.message || res.data);
      return null;
    }
    return res.data?.id || null;
  } catch (err) {
    console.warn('[flow] uploadFlowMediaFromBuffer:', err?.message || err);
    return null;
  }
}

async function uploadFlowMediaForSend(creds, mediaUrl, format = 'IMAGE') {
  if (!creds?.phoneNumberId || !creds?.accessToken || !mediaUrl) return null;

  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    candidates.push(raw);
  };

  add(mediaUrl);
  add(toPermanentUploadPath(mediaUrl));
  add(toPublicMediaUrl(mediaUrl));
  add(toPublicMediaUrl(toPermanentUploadPath(mediaUrl)));

  for (const candidate of candidates) {
    const uploaded = await uploadTemplateHeaderMediaId(creds, candidate, format);
    if (uploaded?.mediaId) return uploaded.mediaId;
  }

  for (const candidate of candidates) {
    try {
      const { buffer, filename } = await readMediaBuffer(candidate);
      const mediaId = await uploadFlowMediaFromBuffer(creds, buffer, filename, format);
      if (mediaId) return mediaId;
    } catch (readErr) {
      console.warn('[flow] readMediaBuffer failed for', candidate, readErr?.message || readErr);
    }
  }
  return null;
}

async function deliverFlowMediaPayload({
  phone,
  userId,
  projectId,
  preferredPhoneNumberId,
  typeKey,
  url,
  rawMediaUrl,
  caption,
  filename,
  credsWithToken,
}) {
  const format = typeKey === 'video' ? 'VIDEO' : typeKey === 'document' ? 'DOCUMENT' : 'IMAGE';
  const publicUrl = resolvePublicMediaUrl(rawMediaUrl || url) || url;

  const trySend = async (mediaId, graphOnly = true) =>
    sendWithBilling({
      phone,
      projectId,
      userId,
      isTemplate: false,
      skipQuotaCheck: true,
      preferredPhoneNumberId,
      graphOnly: isFlowFastDispatch() ? false : graphOnly,
      buildPayload: () =>
        buildMediaPayload({
          to: phone,
          typeKey,
          url: publicUrl,
          mediaId,
          caption,
          filename,
        }),
    });

  // Fast path: one direct send attempt (next flow step starts immediately after).
  if (isFlowFastDispatch() && publicUrl) {
    const fast = await trySend(null, false);
    return fast?.ok ? { ...fast, uploadedMediaId: null } : fast;
  }

  // Fast path: send by public link first (no blocking media upload).
  if (publicUrl) {
    const withLinkAny = await trySend(null, false);
    if (withLinkAny?.ok) return { ...withLinkAny, uploadedMediaId: null };
    const withLinkGraph = await trySend(null, true);
    if (withLinkGraph?.ok) return { ...withLinkGraph, uploadedMediaId: null };
  }

  let uploadedMediaId = null;
  if (typeKey !== 'document' && credsWithToken) {
    uploadedMediaId = await uploadFlowMediaForSend(
      credsWithToken,
      rawMediaUrl || url || publicUrl,
      format
    );
    if (uploadedMediaId) {
      const withId = await trySend(uploadedMediaId, true);
      if (withId?.ok) return { ...withId, uploadedMediaId };
      const withIdAny = await trySend(uploadedMediaId, false);
      if (withIdAny?.ok) return { ...withIdAny, uploadedMediaId };
    }
  }

  if (caption && publicUrl) {
    const withoutCaption = await sendWithBilling({
      phone,
      projectId,
      userId,
      isTemplate: false,
      skipQuotaCheck: true,
      preferredPhoneNumberId,
      graphOnly: true,
      buildPayload: () =>
        buildMediaPayload({
          to: phone,
          typeKey,
          url: publicUrl,
          mediaId: uploadedMediaId,
          caption: '',
          filename,
        }),
    });
    if (withoutCaption?.ok) return { ...withoutCaption, uploadedMediaId };
  }

  return { ok: false, reason: 'media_send_failed', uploadedMediaId };
}

function buildFlowInteractiveInboxPayload({ to, resolvedHeader, text, waButtons }) {
  const publicMediaUrl = resolvePublicMediaUrl(resolvedHeader?.url) || resolvedHeader?.url;
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(publicMediaUrl
        ? {
            header: {
              type: resolvedHeader.type || 'image',
              [resolvedHeader.type || 'image']: { link: publicMediaUrl },
            },
          }
        : {}),
      body: { text: String(text || '').slice(0, 1024) },
      action: { buttons: waButtons || [] },
    },
  };
}

async function saveFlowInteractiveInboxMessage({
  contactId,
  userId,
  projectId,
  phone,
  resolvedHeader,
  text,
  waButtons,
  messageId,
}) {
  if (!contactId || !resolvedHeader?.url) return null;
  const publicMediaUrl = resolvePublicMediaUrl(resolvedHeader.url) || resolvedHeader.url;
  const graphPayload = buildFlowInteractiveInboxPayload({
    to: phone,
    resolvedHeader,
    text,
    waButtons,
  });
  return saveFlowOutboxInboxMessage({
    contactId,
    userId,
    projectId,
    phone,
    graphPayload,
    messageId: messageId || null,
    templateExtras: { mediaUrl: publicMediaUrl },
  });
}

function buildFlowMediaInboxPayload({ typeKey, url, caption, filename, uploadedMediaId, resultPayload }) {
  const publicUrl = resolvePublicMediaUrl(url) || url;
  const basePayload =
    resultPayload ||
    buildMediaPayload({
      to: '',
      typeKey,
      url: publicUrl,
      mediaId: uploadedMediaId,
      caption,
      filename,
    });
  return {
    ...basePayload,
    type: typeKey,
    [typeKey]: {
      ...(basePayload[typeKey] || {}),
      link: basePayload[typeKey]?.link || publicUrl,
      ...(caption ? { caption } : {}),
      ...(filename && typeKey === 'document' ? { filename } : {}),
    },
  };
}

async function buildFlowInteractiveHeader(header, userId, projectId, preferredPhoneNumberId = null) {
  if (!header?.url) return null;

  const headerType = String(header.type || 'image').toLowerCase();
  if (headerType !== 'image' && headerType !== 'video') return null;

  const rawUrl = String(header.url || '').trim();
  const url = resolvePublicMediaUrl(rawUrl) || rawUrl;
  if (!url) return null;

  // Immediate send: use public link header (skip blocking Meta upload).
  return {
    type: headerType,
    [headerType]: { link: url },
  };
}

function buildMediaPayload({ to, typeKey, url, mediaId, caption, filename }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: typeKey,
  };

  const mediaBody = mediaId ? { id: mediaId } : { link: url };
  if (caption && typeKey !== 'document') {
    mediaBody.caption = caption;
  }
  if (typeKey === 'document') {
    mediaBody.filename = filename || guessMediaFilename(url, 'document');
  }

  payload[typeKey] = mediaBody;
  return payload;
}

async function expandProjectIdsForFlowSearch(projectIds, userId, phone) {
  const set = new Set(
    (Array.isArray(projectIds) ? projectIds : [projectIds])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  );

  const uid = Number(userId);
  if (Number.isInteger(uid) && uid > 0) {
    try {
      const owner = await User.findByPk(uid, { attributes: ['projectId'] });
      if (owner?.projectId) set.add(Number(owner.projectId));

      const flowProjects = await Flow.findAll({
        where: { userId: uid },
        attributes: ['projectId'],
        group: ['projectId'],
        raw: true,
      });
      flowProjects.forEach((row) => {
        if (row?.projectId) set.add(Number(row.projectId));
      });
    } catch (_) {
      /* optional */
    }
  }

  const variants = phoneVariantsForLookup(phone);
  if (variants.length) {
    try {
      const audience = await CampaignAudience.findOne({
        where: { phone: { [Op.in]: variants } },
        include: [{ model: Campaign, attributes: ['projectId'], required: true }],
        order: [['updatedAt', 'DESC']],
      });
      if (audience?.Campaign?.projectId) {
        set.add(Number(audience.Campaign.projectId));
      }
    } catch (_) {
      /* optional */
    }
  }

  return [...set];
}

function matchFlowByButtonReply(flows, text) {
  for (const flow of flows || []) {
    const data = parseFlowData(flow);
    const waitNodeId = findFlowWaitNodeByButtonReply(data, text);
    if (waitNodeId) {
      return { flow, waitNodeId };
    }
  }
  return null;
}

async function loadFlowsForSearch(where, limit = 50) {
  return Flow.findAll({
    where,
    order: [['updatedAt', 'DESC']],
    limit,
  });
}

async function findMatchingFlow(projectIds, userId, text, { strictProjectScope = false } = {}) {
  const input = String(text || '').trim();
  if (!input) return null;

  const ids = strictProjectScope
    ? (Array.isArray(projectIds) ? projectIds : [projectIds])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : await expandProjectIdsForFlowSearch(projectIds, userId, null);

  if (strictProjectScope) {
    if (!ids.length) return null;
    const scopeWhere = userId
      ? {
          [Op.or]: [
            { projectId: { [Op.in]: ids } },
            { projectId: null, userId: Number(userId) },
          ],
        }
      : { projectId: { [Op.in]: ids } };
    const flows = await loadFlowsForSearch(scopeWhere, 50);
    for (const flow of flows) {
      const data = parseFlowData(flow);
      const start = (data.nodes || []).find((n) => n.type === 'start');
      if (!start) continue;
      if (matchesStartTrigger(start.data || {}, input)) {
        return flow;
      }
    }
    return null;
  }

  const whereOptions = [];
  if (ids.length) whereOptions.push({ projectId: { [Op.in]: ids } });
  if (userId) whereOptions.push({ userId: Number(userId) });

  const flows =
    whereOptions.length > 0
      ? await loadFlowsForSearch({ [Op.or]: whereOptions }, 50)
      : await loadFlowsForSearch({}, 30);

  for (const flow of flows) {
    const data = parseFlowData(flow);
    const start = (data.nodes || []).find((n) => n.type === 'start');
    if (!start) continue;
    if (matchesStartTrigger(start.data || {}, input)) {
      return flow;
    }
  }
  return null;
}

async function findFlowByTemplateButtonReply(
  projectIds,
  text,
  userId,
  phone,
  { strictProjectScope = false } = {}
) {
  const input = String(text || '').trim();
  if (!input) return null;

  const ids = strictProjectScope
    ? (Array.isArray(projectIds) ? projectIds : [projectIds])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : await expandProjectIdsForFlowSearch(projectIds, userId, phone);

  // 1) Any known project for this user / campaign / webhook
  if (ids.length) {
    const hit = matchFlowByButtonReply(
      await loadFlowsForSearch({ projectId: { [Op.in]: ids } }, 50),
      input
    );
    if (hit) return hit;
  }

  if (strictProjectScope) return null;

  // 2) All flows owned by this user (any project)
  if (userId) {
    const hit = matchFlowByButtonReply(
      await loadFlowsForSearch({ userId: Number(userId) }, 50),
      input
    );
    if (hit) return hit;
  }

  // 3) Last resort: newest flows globally (button label match only)
  const hit = matchFlowByButtonReply(await loadFlowsForSearch({}, 30), input);
  if (hit) {
    console.log('✅ Flow matched across project mismatch (global fallback):', {
      flowId: hit.flow.id,
      flowProjectId: hit.flow.projectId,
      flowUserId: hit.flow.userId,
      buttonText: input,
    });
  }
  return hit;
}

async function findFlowForCampaignTemplate({ templateName, userId, projectId, phone }) {
  const normalized = normalizeMetaTemplateName(templateName);
  if (!normalized) return null;

  const ids = await expandProjectIdsForFlowSearch([projectId], userId, phone);
  const whereOptions = [];
  if (ids.length) whereOptions.push({ projectId: { [Op.in]: ids } });
  if (userId) whereOptions.push({ userId: Number(userId) });

  const flows =
    whereOptions.length > 0
      ? await loadFlowsForSearch({ [Op.or]: whereOptions }, 50)
      : await loadFlowsForSearch({}, 30);

  for (const flow of flows) {
    const data = parseFlowData(flow);
    const start = (data.nodes || []).find((n) => n.type === 'start');
    if (!start) continue;

    const startTemplate = normalizeMetaTemplateName(start.data?.templateName || '');
    const buttons = getTemplateButtonsFromNodeData(start.data || {});
    const edges = (data.edges || []).filter((e) => String(e.source) === String(start.id));
    const hasTemplateWait =
      Boolean(start.data?.templateName || start.data?.templateParts) ||
      buttons.length > 0 ||
      edges.some(
        (e) =>
          e.label ||
          String(e.sourceHandle || '').includes('template-btn')
      );

    if (!hasTemplateWait) continue;
    if (startTemplate && startTemplate === normalized) {
      return { flow, waitNodeId: start.id };
    }
    if (!startTemplate && buttons.length) {
      return { flow, waitNodeId: start.id };
    }
  }

  return null;
}

/**
 * After campaign/broadcast template send, remember which flow + start node is waiting
 * for YES/APPLY / NOT INTERESTED so webhook can continue without re-sending template.
 */
async function seedFlowSessionForCampaignTemplate({ contact, userId, projectId, templateName, phone }) {
  if (!contact?.id || !templateName) return null;

  const match = await findFlowForCampaignTemplate({
    templateName,
    userId,
    projectId,
    phone: phone || contact.phone,
  });
  if (!match?.flow?.id || !match.waitNodeId) return null;

  await saveFlowSession(contact, {
    flowId: match.flow.id,
    currentNodeId: match.waitNodeId,
    projectId: match.flow.projectId || projectId,
  });

  console.log('📌 Flow session seeded after campaign template send:', {
    contactId: contact.id,
    phone: contact.phone,
    flowId: match.flow.id,
    waitNodeId: match.waitNodeId,
    templateName,
  });

  return match;
}

async function sendWithBilling({
  phone,
  projectId,
  userId,
  isTemplate,
  buildPayload,
  skipQuotaCheck = false,
  preferredPhoneNumberId = null,
  graphOnly = undefined,
  cachedCandidates = null,
}) {
  const flowBatch = skipQuotaCheck && activeFlowDispatchContext;
  let billing = flowBatch?.billing || { allowed: true, wasNew: false };
  if (!flowBatch && !skipQuotaCheck) {
    billing = await upsertConversationWithQuota(userId, phone);
    if (!billing.allowed) {
      console.log('Flow send skipped: conversation limit reached for', phone);
      return { ok: false, reason: 'quota' };
    }
  } else if (flowBatch && !billing.allowed) {
    console.log('Flow send skipped: conversation limit reached for', phone);
    return { ok: false, reason: 'quota' };
  }

  let wcc = flowBatch?.wcc || { ok: true, ownerUserId: userId };
  if (!flowBatch && projectId) {
    wcc = await requireWccForOutgoing(projectId, billing, {
      isTemplate: Boolean(isTemplate),
      customerPhone: phone,
    });
    if (!wcc.ok) {
      console.log('Flow send skipped: insufficient WCC for', phone);
      flowMessagePayloadResponse(
        'FLOW_WHATSAPP_SEND_BLOCKED',
        { api: 'AiSensy Direct API', projectId, userId, customerPhone: phone, isTemplate },
        null,
        { ok: false, reason: 'wcc', charge: wcc.charge, balance: wcc.balance }
      );
      return { ok: false, reason: 'wcc' };
    }
  } else if (flowBatch && projectId && !wcc.ok) {
    console.log('Flow send skipped: insufficient WCC for', phone);
    return { ok: false, reason: 'wcc' };
  }

  const candidates =
    cachedCandidates ||
    activeFlowDispatchContext?.credentials ||
    activeFlowSendCredentialCache ||
    (await resolveWhatsAppSendCredentialCandidates(userId, projectId, {
      preferredPhoneNumberId,
    }));
  const payload = buildPayload();
  const payloadType = String(payload?.type || '').toLowerCase();
  const interactiveHeaderType = String(payload?.interactive?.header?.type || '').toLowerCase();
  const shouldUseGraphOnly =
    graphOnly === true ||
    (graphOnly !== false &&
      (['image', 'video', 'document', 'audio'].includes(payloadType) ||
        (payloadType === 'interactive' &&
          (interactiveHeaderType === 'image' || interactiveHeaderType === 'video'))));
  const primaryCred = candidates?.[0];
  const sendRequest = {
    api: 'AiSensy Direct API (POST /direct-apis/t1/messages)',
    phoneNumberId: preferredPhoneNumberId || primaryCred?.phoneNumberId || null,
    credentialSource: primaryCred?.source || 'unknown',
    projectId,
    userId,
    customerPhone: phone,
    messageType: payload?.type || 'unknown',
    isTemplate: Boolean(isTemplate),
    preferredPhoneNumberId: preferredPhoneNumberId || null,
  };

  if (!activeFlowDispatchContext) {
    flowMessagePayloadResponse('FLOW_WHATSAPP_SEND_CALLING', sendRequest, payload, {
      status: 'pending',
    });
  }

  const fastDispatch = isFlowFastDispatch();

  try {
    let sent = await postWhatsAppMessage(candidates, payload, {
      userId,
      projectId,
      preferredPhoneNumberId,
      graphOnly: fastDispatch ? false : shouldUseGraphOnly,
    });
    let messageId = sent?.response?.data?.messages?.[0]?.id || null;

    if (!messageId && fastDispatch && shouldUseGraphOnly) {
      sent = await postWhatsAppMessage(candidates, payload, {
        userId,
        projectId,
        preferredPhoneNumberId,
        graphOnly: true,
      });
      messageId = sent?.response?.data?.messages?.[0]?.id || null;
    }

    if (!messageId) {
      if (!fastDispatch) {
        const errData = sent?.response?.data || { message: 'No message id in WhatsApp API response' };
        flowMessagePayloadResponse('FLOW_WHATSAPP_SEND_NO_MESSAGE_ID', sendRequest, payload, {
          status: sent?.response?.status || 502,
          data: errData,
        });
      }
      return {
        ok: false,
        reason: 'no_message_id',
        error: 'WhatsApp API accepted request but returned no message id',
        response: sent?.response?.data,
      };
    }

    if (!fastDispatch) {
      flowMessagePayloadResponse(
        'FLOW_WHATSAPP_SEND_OK',
        {
          ...sendRequest,
          credentialSource: sent?.creds?.source || sendRequest.credentialSource,
        },
        payload,
        {
          status: sent?.response?.status || 200,
          messageId,
          data: sent?.response?.data || null,
        }
      );
    }

    if (projectId && wcc.ok) {
      setImmediate(() => {
        debitWccAfterSuccessfulMetaSend(projectId, wcc.ownerUserId, billing, {
          isTemplate: Boolean(isTemplate),
          customerPhone: phone,
        }).catch((wccErr) => {
          console.warn('Flow WCC debit failed:', wccErr?.message || wccErr);
        });
      });
    }

    return { ok: true, messageId, response: sent?.response?.data, payload };
  } catch (sendErr) {
    const errData = sendErr?.response?.data || { message: sendErr?.message || String(sendErr) };
    if (!fastDispatch) {
      console.error('Flow WhatsApp send failed:', sendErr?.message || sendErr, {
        phone,
        projectId,
        type: payload?.type,
      });
      flowMessagePayloadResponse('FLOW_WHATSAPP_SEND_ERROR', sendRequest, payload, {
        status: sendErr?.response?.status || 500,
        data: errData,
      });
      logApiFailure({
        direction: 'outbound',
        operation: 'FLOW_WHATSAPP_SEND',
        method: 'POST',
        url: 'aisensy-direct-api/messages',
        status: sendErr?.response?.status || 500,
        message: sendErr?.message || 'Flow WhatsApp send failed',
        projectId,
        userId,
        payload: { type: payload?.type, to: payload?.to },
        response: errData,
        error: sendErr,
      });
    }
    return { ok: false, reason: 'send_failed', error: sendErr?.message || String(sendErr) };
  }
}

async function sendFlowTextFallback({ phone, userId, projectId, body }) {
  const text = String(body || '').trim();
  const to = normalizeWhatsAppRecipient(phone);
  if (!to || !text) return { ok: false, reason: 'empty_body' };
  const result = await sendWithBilling({
    phone: to,
    projectId,
    userId,
    isTemplate: false,
    skipQuotaCheck: true,
    buildPayload: () => ({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (result.ok) {
    console.log('✅ Flow fallback text sent:', { phone: to, projectId });
    return { ok: true, fallback: true, messageId: result.messageId };
  }
  console.error('Flow fallback text send failed:', result?.error || result?.reason);
  return { ok: false, reason: 'fallback_failed', error: result?.error || result?.reason || 'send_failed' };
}

async function sendInteractiveCtaUrl({ phone, userId, projectId, contactId, bodyText, displayText, url }) {
  const to = normalizeWhatsAppRecipient(phone);
  const link = String(url || '').trim();
  if (!to || !link) return { ok: false, reason: 'no_url' };

  const result = await sendWithBilling({
    phone: to,
    projectId,
    userId,
    isTemplate: false,
    skipQuotaCheck: true,
    buildPayload: () => ({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText || displayText || 'Open link' },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: String(displayText || 'Visit').slice(0, 20),
            url: link.startsWith('http') ? link : `https://${link.replace(/^https?:\/\//, '')}`,
          },
        },
      },
    }),
  });

  if (result.ok && contactId && result.payload) {
    queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
      contactId,
      userId,
      projectId,
      phone: to,
      graphPayload: result.payload,
      messageId: result.messageId,
    }));
  }
  return result;
}

/**
 * When Meta-approved template has no BUTTONS component, send session interactive
 * messages so customers get clickable quick-reply / URL / phone actions for flows.
 */
function buttonsFromTemplateVariables(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
  if (Array.isArray(vars.interactiveButtons) && vars.interactiveButtons.length) {
    return normalizeFlowButtons(vars.interactiveButtons);
  }

  const buttons = [];
  const showCta = vars.actionMode === 'cta' || vars.actionMode === 'all';
  const showQr = vars.actionMode === 'quick_reply' || vars.actionMode === 'all';

  if (showCta && Array.isArray(vars.callToActions)) {
    vars.callToActions
      .filter((a) => {
        if (!String(a?.label || '').trim()) return false;
        if (a.type === 'button') return true;
        return Boolean(String(a?.value || '').trim());
      })
      .forEach((cta) => {
        if (cta.type === 'button') {
          buttons.push({ type: 'QUICK_REPLY', text: cta.label });
        } else {
          buttons.push({
            type: cta.type === 'phone' ? 'PHONE_NUMBER' : 'URL',
            text: cta.label,
            url: cta.type === 'url' ? cta.value : undefined,
            phone_number: cta.type === 'phone' ? cta.value : undefined,
          });
        }
      });
  }

  if (showQr && Array.isArray(vars.quickReplies)) {
    vars.quickReplies
      .filter((a) => String(a?.label || '').trim())
      .forEach((qr) => buttons.push({ type: 'QUICK_REPLY', text: qr.label }));
  }

  return normalizeFlowButtons(buttons);
}

function mergeFlowButtons(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const btn of normalizeFlowButtons(list)) {
      const key = `${String(btn.type || 'QUICK_REPLY').toUpperCase()}::${String(btn.text || '').toLowerCase()}`;
      if (!key.endsWith('::') && !seen.has(key)) {
        seen.add(key);
        merged.push(btn);
      }
    }
  }
  return merged;
}

function collectFlowTemplateButtons(step, templateRecord, metaComponents) {
  const parts = step?.templateParts || {};
  return mergeFlowButtons(
    parts.buttons,
    step?.buttons,
    buttonsFromTemplateVariables(templateRecord?.variables),
    extractButtonsFromComponents(metaComponents || [])
  );
}

function resolveFlowTemplateHeaderUrl(step, templateRecord) {
  const candidates = [
    step?.templateParts?.headerImageUrl,
    step?.headerMediaUrl,
    step?.header_media_url,
    step?.templateParts?.headerMediaUrl,
    step?.templateParts?.header_media_url,
    templateRecord?.variables?.headerMediaUrl,
    templateRecord?.variables?.header_media_url,
  ];
  for (const candidate of candidates) {
    const url = toPublicMediaUrl(candidate);
    if (url) return url;
  }
  return null;
}

async function resolveFlowTemplateHeaderUrlAsync(step, templateRecord, projectId, templateName) {
  const direct = resolveFlowTemplateHeaderUrl(step, templateRecord);
  if (direct) return direct;
  try {
    return await resolveHeaderFromCampaign(templateName || step?.templateName, projectId);
  } catch (_) {
    return null;
  }
}

async function loadTemplateRecordForFlow({ userId, projectId, templateName }) {
  let template = await loadTemplateRecordForCampaign({ userId, projectId, templateName });
  if (template || !userId) return template;

  const normalized = normalizeMetaTemplateName(templateName);
  const where = { userId: Number(userId) };
  if (normalized) {
    template = await Template.findOne({
      where: { ...where, name: normalized },
      attributes: ['id', 'name', 'content', 'status', 'category', 'variables', 'metaTemplateId'],
      order: [['updatedAt', 'DESC']],
    });
  }
  if (!template && templateName) {
    template = await Template.findOne({
      where: { ...where, name: templateName },
      attributes: ['id', 'name', 'content', 'status', 'category', 'variables', 'metaTemplateId'],
      order: [['updatedAt', 'DESC']],
    });
  }
  return template;
}

async function dispatchTemplateButtonFollowUps({
  phone,
  userId,
  projectId,
  contactId,
  step,
  flowButtons,
  metaQuickTexts,
  forceAllQuickReplies = false,
  templateDelivered = false,
}) {
  const buttons = flowButtons || [];
  if (!buttons.length) {
    return { ok: true, skipped: true, reason: 'no_flow_buttons' };
  }

  const quickReplies = buttons.filter((b) => String(b.type).toUpperCase() === 'QUICK_REPLY');
  const urlButtons = buttons.filter((b) => String(b.type).toUpperCase() === 'URL');
  const phoneButtons = buttons.filter((b) => String(b.type).toUpperCase() === 'PHONE_NUMBER');
  const metaQuick = (metaQuickTexts || []).filter(Boolean);

  if (metaQuick.length > 0 && templateDelivered && !forceAllQuickReplies) {
    return { ok: true, skipped: true, reason: 'template_includes_buttons' };
  }

  const results = [];
  const quickLabels = quickReplies
    .map((b) => b.text)
    .filter((label) => {
      if (forceAllQuickReplies || !metaQuick.length) return true;
      return !metaQuick.some((meta) => buttonsMatch(meta, label));
    });

  if (quickLabels.length) {
    const res = await sendFlowReplyOptions({
      phone,
      userId,
      projectId,
      contactId,
      bodyText: personalizeFlowMessageText(
        step?.templateParts?.body ||
          step?.templateContent ||
          'Please choose an option:',
        activeFlowDispatchContext?.contact || null,
        phone
      ),
      options: quickLabels,
    });
    results.push(res);
    console.log('📲 Flow template button follow-up:', {
      template: step?.templateName,
      optionCount: quickLabels.length,
      ok: res?.ok,
      reason: res?.reason,
    });
  }

  for (const urlBtn of urlButtons.slice(0, 2)) {
    const res = await sendInteractiveCtaUrl({
      phone,
      userId,
      projectId,
      contactId,
      bodyText: urlBtn.text,
      displayText: urlBtn.text,
      url: urlBtn.url,
    });
    results.push(res);
  }

  for (const phoneBtn of phoneButtons.slice(0, 1)) {
    const number = phoneBtn.phone_number || phoneBtn.text;
    const res = await sendFlowStep({
      phone,
      userId,
      projectId,
      contactId,
      step: {
        type: 'text',
        text: `${phoneBtn.text}\n📞 ${number}`,
      },
    });
    results.push(res);
  }

  const sent = results.some((r) => r?.ok);
  return { ok: sent || results.length === 0, results };
}

async function sendTemplateActionFollowUps(params) {
  return dispatchTemplateButtonFollowUps(params);
}

async function sendFlowTemplateStep({ phone, userId, projectId, contactId, step }) {
  const to = normalizeWhatsAppRecipient(phone);
  const templateName = normalizeMetaTemplateName(step.templateName);
  if (!to || !templateName) return { ok: false, reason: 'no_template_name' };

  const templateRecord = await loadTemplateRecordForFlowCached({
    userId,
    projectId,
    templateName: step.templateName,
  });

  const resolved = isFlowFastDispatch() && templateRecord
    ? {
        components:
          templateRecord.components ||
          templateRecord.variables?.components ||
          getTemplateComponents(templateRecord) ||
          [],
        language: templateRecord.language || step.templateLanguage || 'en_US',
      }
    : await resolveTemplateForFlow({
        template: templateRecord || { name: step.templateName, variables: step.templateParts },
        userId,
        projectId,
        templateName: step.templateName,
      });

  const metaComponents = resolved.components || [];
  const flowButtons = collectFlowTemplateButtons(step, templateRecord, metaComponents);
  const metaQuickTexts = extractButtonsFromComponents(metaComponents)
    .filter((b) => String(b.type || '').toUpperCase() === 'QUICK_REPLY')
    .map((b) => b.text);

  const enrichedStep = {
    ...step,
    templateContent:
      step.templateContent ||
      step?.templateParts?.body ||
      templateRecord?.content ||
      '',
    templateParts: {
      ...(step.templateParts || {}),
      body:
        step?.templateParts?.body ||
        step.templateContent ||
        templateRecord?.content ||
        '',
      buttons: flowButtons.length ? flowButtons : step?.templateParts?.buttons || [],
    },
    buttons: flowButtons
      .filter((b) => String(b.type).toUpperCase() === 'QUICK_REPLY')
      .map((b) => b.text),
  };

  const templateContent =
    enrichedStep.templateContent || templateRecord?.content || '';
  const sendSpec = parseTemplateSendSpec(metaComponents, templateContent);
  const bodyVarNums = extractFlowTemplateBodyVarNums(sendSpec, templateContent);

  let flowContact = activeFlowDispatchContext?.contact || null;
  if (!flowContact && contactId) {
    try {
      flowContact = await Contact.findByPk(contactId, {
        attributes: ['id', 'name', 'phone', 'customFields'],
      });
    } catch (_) {
      flowContact = null;
    }
  }

  const audienceMember = buildFlowAudienceMember({
    contact: flowContact,
    phone: to,
    bodyVarNums,
  });
  const templateParams = bodyVarNums.map((n) => audienceMember[`var${n}`] ?? '');

  const headerUrl = isFlowFastDispatch()
    ? resolveFlowTemplateHeaderUrl(enrichedStep, templateRecord)
    : await resolveFlowTemplateHeaderUrlAsync(
        enrichedStep,
        templateRecord,
        projectId,
        step.templateName
      );
  let waComponents;
  let headerMediaId = null;
  try {
    waComponents = buildFlowTemplateWaComponents({
      sendSpec,
      bodyVarNums,
      headerMediaUrl: headerUrl,
      headerMediaId,
      audienceMember,
    });
    const buttonComponents = extractDynamicUrlButtonComponents(metaComponents, audienceMember);
    if (buttonComponents.length) {
      waComponents = [...(waComponents || []), ...buttonComponents];
    }
  } catch (compErr) {
    console.warn('Flow template components build failed:', compErr.message);
    waComponents = buildFlowTemplateWaComponents({
      sendSpec,
      bodyVarNums,
      headerMediaUrl: null,
      headerMediaId: null,
      audienceMember,
    });
  }

  const language = step.templateLanguage || resolved.language || 'en_US';

  console.log('📤 Flow template send', {
    template: templateName,
    language,
    headerFormat: sendSpec.headerFormat,
    needsHeaderMedia: sendSpec.needsHeaderMedia,
    hasHeaderUrl: Boolean(headerUrl),
    metaButtonCount: extractButtonsFromComponents(metaComponents).length,
    metaQuickReplyCount: metaQuickTexts.length,
    flowButtonCount: flowButtons.length,
    willSendButtonFollowUp: flowButtons.length > 0 && metaQuickTexts.length === 0,
  });

  const buildTemplatePayload = (components) => ({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      ...(components?.length ? { components } : {}),
    },
  });

  let result = await sendWithBilling({
    phone: to,
    projectId,
    userId,
    isTemplate: true,
    skipQuotaCheck: true,
    buildPayload: () => buildTemplatePayload(waComponents),
  });

  if (!result.ok && !waComponents?.length && bodyVarNums.length > 0) {
    console.warn('Flow template retry with body params only:', result.reason || result.error);
    waComponents = buildFlowTemplateWaComponents({
      sendSpec,
      bodyVarNums,
      headerMediaUrl: null,
      headerMediaId: null,
      audienceMember,
    });
    if (waComponents?.length) {
      result = await sendWithBilling({
        phone: to,
        projectId,
        userId,
        isTemplate: true,
        skipQuotaCheck: true,
        buildPayload: () => buildTemplatePayload(waComponents),
      });
    }
  }

  let templateDelivered = Boolean(result.ok);

  if (!result.ok) {
    const fallbackBody = personalizeFlowMessageText(
      templateBodyFallbackText(enrichedStep),
      flowContact,
      to
    );
    if (fallbackBody) {
      console.warn('Flow template send failed, falling back to text:', result.reason || result.error);
      const fallbackResult = await sendFlowTextFallback({
        phone: to,
        userId,
        projectId,
        body: fallbackBody,
      });
      templateDelivered = Boolean(fallbackResult?.ok);
      result = { ...result, ok: templateDelivered, fallback: true };
    }
  }

  if (templateDelivered && contactId) {
    try {
      const clientPreview = buildClientTemplatePreview(
        templateRecord || { name: templateName, variables: enrichedStep.templateParts, content: enrichedStep.templateContent },
        enrichedStep.templateContent || '',
        {
          templateName,
          templateParams,
          headerImageUrl: headerUrl,
        }
      );
      const graphPayload =
        result.payload ||
        buildTemplatePayload(waComponents);
      const snapshotForInbox = finalizeTemplateSnapshotForInbox(
        clientPreview,
        graphPayload,
        headerUrl
      );
      queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
        contactId,
        userId,
        projectId,
        phone: to,
        graphPayload,
        messageId: result.messageId || null,
        templateExtras: {
          isTemplateSend: true,
          templateName,
          message: snapshotForInbox?.body || enrichedStep.templateContent || `[Template] ${step.templateName}`,
          templateSnapshot: snapshotForInbox ? JSON.stringify(snapshotForInbox) : null,
          templatePreview: snapshotForInbox,
          mediaUrl: snapshotForInbox?.headerImageUrl || snapshotForInbox?.header?.url || headerUrl || null,
        },
      }));
    } catch (inboxErr) {
      console.warn('Flow inbox save failed (template):', inboxErr?.message || inboxErr);
    }
  }

  const followUp = await dispatchTemplateButtonFollowUps({
    phone: to,
    userId,
    projectId,
    contactId,
    step: enrichedStep,
    flowButtons,
    metaQuickTexts,
    forceAllQuickReplies: !templateDelivered && flowButtons.length > 0,
    templateDelivered,
  });

  if (followUp.results?.length) {
    console.log('✅ Flow template follow-up actions:', {
      count: followUp.results.length,
      sent: followUp.results.filter((r) => r?.ok).length,
    });
  }

  const buttonsDelivered = followUp.results?.some((r) => r?.ok);
  return {
    ...result,
    ok: templateDelivered || buttonsDelivered,
    templateDelivered,
    buttonsDelivered,
    followUp,
  };
}

function buildWaReplyButtons(options) {
  return (options || [])
    .filter(Boolean)
    .slice(0, 3)
    .map((label, i) => ({
      type: 'reply',
      reply: {
        id: `flow_btn_${i}`,
        title: String(label).slice(0, 20),
      },
    }));
}

async function sendFlowReplyOptions({
  phone,
  userId,
  projectId,
  contactId,
  bodyText,
  options,
  header,
  preferredPhoneNumberId = null,
}) {
  const to = normalizeWhatsAppRecipient(phone);
  const labels = (options || []).map((l) => String(l || '').trim()).filter(Boolean);
  if (!labels.length) return { ok: false, reason: 'no_buttons' };

  const text = String(bodyText || 'Choose an option').slice(0, 1024);
  const resolvedHeader = header?.url
    ? {
        ...header,
        url: resolvePublicMediaUrl(header.url) || String(header.url).trim(),
      }
    : header;
  const splitMediaButtons =
    String(process.env.FLOW_SPLIT_MEDIA_BUTTONS ?? 'true').toLowerCase() !== 'false' &&
    resolvedHeader?.url &&
    (resolvedHeader.type === 'image' || resolvedHeader.type === 'video') &&
    labels.length <= 3;

  const waButtons = buildWaReplyButtons(labels);

  // Send buttons/text first for immediate customer reply; media follows without blocking.
  if (splitMediaButtons) {
    const buttonPrompt = text.slice(0, 1024);
    const buttonGraphPayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: buttonPrompt },
        action: { buttons: waButtons },
      },
    };

    let buttonResult = await sendWithBilling({
      phone: to,
      projectId,
      userId,
      isTemplate: false,
      skipQuotaCheck: true,
      preferredPhoneNumberId,
      buildPayload: () => buttonGraphPayload,
    });

    if (!buttonResult?.ok) {
      const fallbackBody = [text, ...labels].filter(Boolean).join('\n');
      buttonResult = await sendFlowTextFallback({
        phone: to,
        userId,
        projectId,
        body: fallbackBody,
      });
    }

    const mediaStep = {
      mediaUrl: resolvedHeader.url,
      mediaType: resolvedHeader.type === 'video' ? 'VIDEO' : 'IMAGE',
      caption: '',
    };
    setImmediate(() => {
      sendFlowMediaOnly({
        phone: to,
        userId,
        projectId,
        contactId: null,
        preferredPhoneNumberId,
        step: mediaStep,
      }).catch((mediaErr) => {
        console.warn('Flow deferred media send failed:', mediaErr?.message || mediaErr);
      });
    });

    const ok = Boolean(buttonResult?.ok);
    console.log('📤 Flow immediate buttons + deferred media:', {
      phone: to,
      buttonsOk: buttonResult?.ok,
      labels,
    });

    if (contactId) {
      queueFlowInboxSave(() => saveFlowInteractiveInboxMessage({
        contactId,
        userId,
        projectId,
        phone: to,
        resolvedHeader,
        text,
        waButtons,
        messageId: buttonResult?.messageId || null,
      }));
    }

    return {
      ok,
      splitSend: true,
      mediaResult: { ok: true, deferred: true },
      buttonResult,
      reason: ok ? undefined : 'buttons_failed',
    };
  }

  if (resolvedHeader?.url && labels.length > 3) {
    await sendFlowMediaOnly({
      phone: to,
      userId,
      projectId,
      contactId,
      step: {
        mediaUrl: resolvedHeader.url,
        mediaType: resolvedHeader.type === 'video' ? 'VIDEO' : 'IMAGE',
        caption: '',
      },
    });
  }

  if (labels.length <= 3) {
    const waButtons = buildWaReplyButtons(labels);
    const linkHeader = resolvedHeader?.url
      ? {
          type: resolvedHeader.type || 'image',
          [resolvedHeader.type || 'image']: {
            link: resolvePublicMediaUrl(resolvedHeader.url) || resolvedHeader.url,
          },
        }
      : null;
    const interactive = {
      type: 'button',
      body: { text },
      action: { buttons: waButtons },
      ...(linkHeader ? { header: linkHeader } : {}),
    };

    const buildInteractivePayload = (headerOverride) => ({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        ...interactive,
        ...(headerOverride !== undefined ? { header: headerOverride } : {}),
      },
    });

    let result = await sendWithBilling({
      phone: to,
      projectId,
      userId,
      isTemplate: false,
      skipQuotaCheck: true,
      preferredPhoneNumberId,
      buildPayload: () => buildInteractivePayload(linkHeader || undefined),
    });

    if (!result.ok && linkHeader && !isFlowFastDispatch()) {
      result = await sendWithBilling({
        phone: to,
        projectId,
        userId,
        isTemplate: false,
        skipQuotaCheck: true,
        preferredPhoneNumberId,
        buildPayload: () => buildInteractivePayload(undefined),
      });
    }

    if (!result.ok && !isFlowFastDispatch()) {
      if (resolvedHeader?.url) {
        const mediaResult = await sendFlowMediaOnly({
          phone: to,
          userId,
          projectId,
          contactId: null,
          preferredPhoneNumberId,
          step: {
            mediaUrl: resolvedHeader.url,
            mediaType: resolvedHeader.type === 'video' ? 'VIDEO' : 'IMAGE',
            caption: '',
          },
        });
        if (mediaResult?.ok) {
          const buttonsOnly = {
            type: 'button',
            body: { text: String(process.env.FLOW_BUTTON_PROMPT || text).slice(0, 1024) },
            action: { buttons: waButtons },
          };
          result = await sendWithBilling({
            phone: to,
            projectId,
            userId,
            isTemplate: false,
            skipQuotaCheck: true,
            preferredPhoneNumberId,
            buildPayload: () => ({
              messaging_product: 'whatsapp',
              to,
              type: 'interactive',
              interactive: buttonsOnly,
            }),
          });
          if (result.ok) {
            result.splitSend = true;
            result.mediaResult = mediaResult;
          }
        }
      } else {
        const fallbackBody = [text, ...labels].filter(Boolean).join('\n');
        result = await sendFlowTextFallback({
          phone: to,
          userId,
          projectId,
          body: fallbackBody,
        });
      }
    }

    if (contactId && resolvedHeader?.url) {
      queueFlowInboxSave(() => saveFlowInteractiveInboxMessage({
        contactId,
        userId,
        projectId,
        phone: to,
        resolvedHeader,
        text,
        waButtons,
        messageId: result?.messageId || result?.mediaResult?.messageId || null,
      }));
    } else if (result.ok && contactId && result.payload) {
      queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
        contactId,
        userId,
        projectId,
        phone: to,
        graphPayload: result.payload,
        messageId: result.messageId,
      }));
    }

    return result;
  }

  const rows = labels.slice(0, 10).map((label, i) => ({
    id: `flow_opt_${i}`,
    title: String(label).slice(0, 24),
  }));

  let result = await sendWithBilling({
    phone: to,
    projectId,
    userId,
    isTemplate: false,
    skipQuotaCheck: true,
    preferredPhoneNumberId,
    buildPayload: () => ({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text },
        action: {
          button: 'View options',
          sections: [{ title: 'Options', rows }],
        },
      },
    }),
  });

  if (!result.ok) {
    const fallbackBody = [text, ...labels].filter(Boolean).join('\n');
    result = await sendFlowTextFallback({
      phone: to,
      userId,
      projectId,
      body: fallbackBody,
    });
  }

  if (result.ok && contactId && result.payload) {
    queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
      contactId,
      userId,
      projectId,
      phone: to,
      graphPayload: result.payload,
      messageId: result.messageId,
    }));
  }

  return result;
}

async function sendFlowInteractiveButtons(params) {
  return sendFlowReplyOptions(params);
}

async function sendFlowMediaOnly({ phone, userId, projectId, contactId, step, preferredPhoneNumberId = null }) {
  const to = normalizeWhatsAppRecipient(phone);
  const mediaType = String(step.mediaType || 'IMAGE').toUpperCase();
  const rawMediaUrl = String(step.mediaUrl || '').trim();
  const url = resolvePublicMediaUrl(rawMediaUrl) || rawMediaUrl;
  if (!url) return { ok: false, reason: 'no_media_url' };

  const typeKey = mediaType === 'VIDEO' ? 'video' : mediaType === 'DOCUMENT' ? 'document' : 'image';
  const caption = String(step.caption || '').trim();
  const filename = guessMediaFilename(url, typeKey);

  const candidates =
    activeFlowDispatchContext?.credentials ||
    activeFlowSendCredentialCache ||
    (await resolveWhatsAppSendCredentialCandidates(userId, projectId, {
      preferredPhoneNumberId,
    }));
  const credsWithToken = (candidates || []).find((c) => c?.accessToken && c?.phoneNumberId);

  const result = await deliverFlowMediaPayload({
    phone: to,
    userId,
    projectId,
    preferredPhoneNumberId,
    typeKey,
    url,
    rawMediaUrl,
    caption,
    filename,
    credsWithToken,
  });

  if (result?.ok && contactId) {
    const graphPayload = buildFlowMediaInboxPayload({
      typeKey,
      url: rawMediaUrl || url,
      caption,
      filename,
      uploadedMediaId: result.uploadedMediaId,
      resultPayload: result.payload,
    });
    queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
      contactId,
      userId,
      projectId,
      phone: to,
      graphPayload,
      messageId: result.messageId || null,
      templateExtras: { mediaUrl: resolvePublicMediaUrl(rawMediaUrl || url) || url },
    }));
  }

  return result;
}

async function sendFlowStep({ phone, userId, projectId, contactId, step, preferredPhoneNumberId = null }) {
  const to = normalizeWhatsAppRecipient(phone);
  if (!to || !step) return { ok: false };

  try {
    if (step.type === 'template') {
      return sendFlowTemplateStep({ phone: to, userId, projectId, contactId, step });
    }

    if (step.type === 'text' || step.type === 'error') {
      const flowContact = activeFlowDispatchContext?.contact || null;
      const rawBody =
        step.type === 'error'
          ? (step.message || step.text || 'Invalid input.')
          : [step.text, step.footer].filter(Boolean).join('\n\n');
      const body = personalizeFlowMessageText(rawBody, flowContact, to);
      let result = await sendWithBilling({
        phone: to,
        projectId,
        userId,
        isTemplate: false,
        skipQuotaCheck: true,
        preferredPhoneNumberId,
        buildPayload: () => ({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: body || ' ' },
        }),
      });
      if (!result.ok && !isFlowFastDispatch()) {
        result = await sendFlowTextFallback({
          phone: to,
          userId,
          projectId,
          body,
        });
      }
      if (result.ok && contactId) {
        const graphPayload =
          result.payload || { type: 'text', text: { body: body || ' ' } };
        queueFlowInboxSave(() => saveFlowOutboxInboxMessage({
          contactId,
          userId,
          projectId,
          phone: to,
          graphPayload,
          messageId: result.messageId || null,
        }));
      }
      return result;
    }

    if (step.type === 'media') {
      const mediaType = String(step.mediaType || 'IMAGE').toUpperCase();
      const rawMediaUrl = String(step.mediaUrl || '').trim();
      const url = resolvePublicMediaUrl(rawMediaUrl) || rawMediaUrl;
      const flowContact = activeFlowDispatchContext?.contact || null;
      const caption = personalizeFlowMessageText(
        String(step.caption || step.text || '').trim(),
        flowContact,
        to
      );
      const options = (step.buttons || []).filter(Boolean);

      if (options.length > 0) {
        const header =
          url && mediaType === 'IMAGE'
            ? { type: 'image', url: rawMediaUrl || url }
            : url && mediaType === 'VIDEO'
              ? { type: 'video', url: rawMediaUrl || url }
              : null;

        let result = await sendFlowReplyOptions({
          phone: to,
          userId,
          projectId,
          contactId,
          bodyText: caption || 'Choose an option',
          options,
          header,
          preferredPhoneNumberId,
        });

        if (!result?.ok && url && !isFlowFastDispatch()) {
          await sendFlowMediaOnly({
            phone: to,
            userId,
            projectId,
            contactId,
            preferredPhoneNumberId,
            step: { ...step, caption: '', buttons: [] },
          });
          result = await sendFlowReplyOptions({
            phone: to,
            userId,
            projectId,
            contactId,
            bodyText: caption || 'Choose an option',
            options,
            preferredPhoneNumberId,
          });
        }

        if (result?.ok) return result;
      }

      if (!url) return { ok: false, reason: 'no_media_url' };
      return sendFlowMediaOnly({ phone: to, userId, projectId, contactId, step, preferredPhoneNumberId });
    }

    if (step.type === 'button' || step.type === 'question') {
      const bodyText = step.type === 'question' ? step.question : step.text;
      const options = step.buttons || step.options || [];

      if (options.filter(Boolean).length > 0) {
        return sendFlowReplyOptions({
          phone: to,
          userId,
          projectId,
          contactId,
          bodyText: bodyText || 'Choose an option',
          options,
          preferredPhoneNumberId,
        });
      }

      return sendFlowStep({
        phone: to,
        userId,
        projectId,
        contactId,
        preferredPhoneNumberId,
        step: { type: 'text', text: bodyText },
      });
    }

    if (step.type === 'list') {
      const rows = (step.sections || [])
        .flatMap((sec) =>
          (sec.items || []).map((item) => ({
            id: String(item).slice(0, 24),
            title: String(item).slice(0, 24),
          }))
        )
        .slice(0, 10);

      const sections =
        rows.length > 0
          ? [{ title: 'Options', rows }]
          : [{ title: 'Options', rows: [{ id: 'opt_1', title: 'Option 1' }] }];

      return sendWithBilling({
        phone: to,
        projectId,
        userId,
        isTemplate: false,
        preferredPhoneNumberId,
        buildPayload: () => ({
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: step.header ? { type: 'text', text: String(step.header).slice(0, 60) } : undefined,
            body: { text: step.body || 'Choose an option' },
            footer: step.footer ? { text: String(step.footer).slice(0, 60) } : undefined,
            action: {
              button: String(step.listButton || 'list').slice(0, 20),
              sections,
            },
          },
        }),
      });
    }

    if (step.type === 'set_attribute') {
      if (contactId && projectId) {
        const attr = String(step.attribute || '').trim().toLowerCase();
        const value = String(step.value || '').trim();
        let tagName = '';
        if (attr === 'tag' || attr === 'tags') {
          tagName = value;
        } else if (value) {
          tagName = value;
        } else if (step.attribute) {
          tagName = String(step.attribute).trim();
        }
        if (tagName) {
          try {
            await tagService.assignTagByName({
              contactId,
              projectId,
              userId,
              tagName,
            });
          } catch (tagErr) {
            console.warn('Flow set_attribute tag assign failed:', tagErr?.message || tagErr);
          }
        }
      }
      return { ok: true, skipped: true };
    }

    return { ok: false, reason: 'unknown_step' };
  } catch (err) {
    console.error('sendFlowStep error:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function sendFlowOutputs({ phone, userId, projectId, contactId, output, preferredPhoneNumberId = null }) {
  const steps = (output || []).filter(Boolean);
  const results = new Array(steps.length);
  let sentCount = 0;
  if (!steps.length) return { results: [], sentCount: 0 };

  const normalizedPhone = normalizeWhatsAppRecipient(phone);

  const templateNames = [
    ...new Set(
      steps
        .filter((s) => s.type === 'template' && s.templateName)
        .map((s) => s.templateName)
    ),
  ];
  activeFlowTemplateRecordCache = new Map();

  const prefetchPromises = [
    resolveWhatsAppSendCredentialCandidates(userId, projectId, { preferredPhoneNumberId }),
    upsertConversationWithQuota(userId, normalizedPhone).catch(() => ({
      allowed: true,
      wasNew: false,
    })),
    ...templateNames.map((templateName) =>
      loadTemplateRecordForFlowCached({ userId, projectId, templateName })
    ),
  ];
  const prefetchResults = await Promise.all(prefetchPromises);
  const credentials = prefetchResults[0];
  const billing = prefetchResults[1];

  let wcc = { ok: true, ownerUserId: userId };
  if (billing.allowed && projectId) {
    try {
      wcc = await requireWccForOutgoing(projectId, billing, {
        isTemplate: false,
        customerPhone: normalizedPhone,
      });
    } catch (wccErr) {
      console.warn('Flow dispatch WCC prefetch failed:', wccErr?.message || wccErr);
    }
  }

  if (!billing.allowed || !wcc.ok) {
    return { results: [], sentCount: 0 };
  }

  let flowContact = null;
  if (contactId) {
    try {
      flowContact = await Contact.findByPk(contactId, {
        attributes: ['id', 'name', 'phone', 'customFields'],
      });
    } catch (_) {
      flowContact = null;
    }
  }

  activeFlowSendCredentialCache = credentials;
  activeFlowDispatchContext = {
    credentials,
    billing,
    wcc,
    userId,
    projectId,
    phone: normalizedPhone,
    contact: flowContact,
  };

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.type === 'set_attribute') {
        results[index] = { ok: true, skipped: true };
        setImmediate(() => {
          sendFlowStep({
            phone,
            userId,
            projectId,
            contactId,
            step,
            preferredPhoneNumberId,
          }).catch((attrErr) => {
            console.warn('Flow set_attribute deferred step failed:', attrErr?.message || attrErr);
          });
        });
        continue;
      }

      const res = await sendFlowStep({
        phone,
        userId,
        projectId,
        contactId,
        step,
        preferredPhoneNumberId,
      });
      results[index] = res;
      if (res?.ok && !res?.skipped) sentCount += 1;
      if (!res?.ok) {
        console.warn('Flow step send failed:', {
          phone,
          projectId,
          stepType: step?.type,
          reason: res?.reason || res?.error,
        });
      }
    }
  } finally {
    activeFlowSendCredentialCache = null;
    activeFlowDispatchContext = null;
    activeFlowTemplateRecordCache = null;
  }

  return { results, sentCount };
}

async function ensureContactForFlow(contact) {
  return contact;
}

/**
 * Handle inbound WhatsApp message against active or keyword-triggered flows.
 * Uses Scenario 2 (template quick-reply) and Scenario 3 (keyword) — not Meta WhatsApp Flows.
 */
function isButtonTapInbound(inboundKind) {
  return inboundKind === 'template_quick_reply' || inboundKind === 'interactive';
}

function buildInboundProjectScope(webhookProjectId, contactProjectId) {
  const ids = [];
  const add = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  };
  add(webhookProjectId);
  add(contactProjectId);
  return ids;
}

function flowResultMeta(flow, matchSource, extra = {}) {
  return {
    flowId: flow?.id ?? null,
    flowName: flow?.name ?? null,
    matchSource: matchSource || null,
    ...extra,
  };
}

/** True only when the flow actually sent or produced dispatchable steps — avoids silent "handled". */
function isFlowDispatchHandled(sendMeta) {
  if ((sendMeta?.sentCount || 0) > 0) return true;
  const outputCount = sendMeta?.outputCount || 0;
  if (outputCount <= 0) return false;
  const results = sendMeta?.results || [];
  return results.some((r) => r?.ok);
}

async function handleInboundFlowMessage({
  contact,
  userId,
  projectId,
  inboundText,
  replyCandidates,
  inboundPhone,
  inboundKind = 'unknown',
  inboundPhoneNumberId = null,
}) {
  const flowUserId = userId || contact?.userId;
  if (!contact || !flowUserId) {
    return { handled: false, reason: 'missing_context' };
  }

  const phone = normalizeWhatsAppRecipient(inboundPhone || contact.phone);
  const inboundProjectId =
    Number(projectId || contact?.projectId) > 0
      ? Number(projectId || contact?.projectId)
      : null;
  const projectCandidates = inboundProjectId
    ? buildInboundProjectScope(inboundProjectId, contact?.projectId)
    : await expandProjectIdsForFlowSearch([projectId, contact?.projectId], flowUserId, phone);
  const strictProjectScope = Boolean(inboundProjectId);

  projectId = inboundProjectId || projectCandidates[0] || null;

  contact = await ensureContactForFlow(contact);
  if (projectId && contact?.projectId && Number(contact.projectId) !== Number(projectId)) {
    const syncProjectId = Number(projectId);
    contact.projectId = syncProjectId;
    setImmediate(() => {
      contact.update({ projectId: syncProjectId }).catch((syncErr) => {
        console.warn('Could not sync contact to inbound project:', syncErr?.message);
      });
    });
  }
  const texts = [];
  const addText = (value) => {
    const s = String(value || '').trim();
    if (s && !texts.some((t) => t.toLowerCase() === s.toLowerCase())) texts.push(s);
  };
  addText(inboundText);
  (replyCandidates || []).forEach(addText);
  if (!texts.length) return { handled: false, reason: 'empty_text' };

  console.log('🔵 Flow inbound handler:', {
    contactId: contact.id,
    phone,
    projectId,
    inboundText,
    replyCandidates: texts,
  });

  let matchedText = texts[0];
  let session = await getFlowSession(contact, projectId);
  const replyPhoneNumberId =
    String(inboundPhoneNumberId || session?.phoneNumberId || '').trim() || null;

  if (!session) {
    const sessionContact = await findContactWithFlowSession(phone, flowUserId, projectId);
    if (sessionContact && sessionContact.id !== contact.id) {
      const altSession = await getFlowSession(sessionContact, projectId);
      if (altSession) {
        console.log('🔄 Flow session recovered from alternate contact record:', {
          currentContactId: contact.id,
          sessionContactId: sessionContact.id,
          phone,
          projectId,
          flowId: altSession.flowId,
          currentNodeId: altSession.currentNodeId,
        });
        contact = sessionContact;
        session = altSession;
      }
    }
  }

  let flow = null;
  let templateButtonWaitNodeId = null;
  let matchSource = null;

  // Template / interactive taps must match the WhatsApp account (project) that sent the message.
  if (isButtonTapInbound(inboundKind)) {
    for (const candidate of texts) {
      const buttonMatch = await findFlowByTemplateButtonReply(
        projectCandidates,
        candidate,
        flowUserId,
        phone,
        { strictProjectScope }
      );
      if (!buttonMatch) continue;

      const sessionConflicts =
        session &&
        (Number(session.flowId) !== Number(buttonMatch.flow.id) ||
          String(session.currentNodeId || '') !== String(buttonMatch.waitNodeId || '') ||
          (session.projectId && projectId && Number(session.projectId) !== Number(projectId)));

      if (sessionConflicts) {
        console.log('🔄 Clearing stale flow session — template button restart on this project:', {
          contactId: contact.id,
          projectId,
          oldFlowId: session.flowId,
          oldNodeId: session.currentNodeId,
          oldSessionProjectId: session.projectId || null,
          buttonText: candidate,
          newFlowId: buttonMatch.flow.id,
          newWaitNodeId: buttonMatch.waitNodeId,
        });
        queueFlowSessionSave(() => clearFlowSession(contact));
        session = null;
      }

      flow = buttonMatch.flow;
      templateButtonWaitNodeId = buttonMatch.waitNodeId;
      matchedText = candidate;
      matchSource = 'template_button';
      console.log('✅ Flow matched interactive/button reply:', {
        flowId: flow.id,
        flowName: flow.name,
        projectId: flow.projectId,
        waitNodeId: templateButtonWaitNodeId,
        buttonText: candidate,
      });
      break;
    }
  }

  // Keyword on Flow Start (e.g. "hi") must run before an old session, or keywords never fire.
  if (!flow && !isButtonTapInbound(inboundKind)) {
    for (const candidate of texts) {
      const keywordFlow = await findMatchingFlow(projectCandidates, flowUserId, candidate, {
        strictProjectScope,
      });
      if (!keywordFlow) continue;
      if (
        projectId &&
        keywordFlow.projectId &&
        Number(keywordFlow.projectId) !== Number(projectId)
      ) {
        continue;
      }
      if (session?.flowId) {
        console.log('🔄 Clearing flow session — keyword trigger restart:', {
          contactId: contact.id,
          keyword: candidate,
          oldFlowId: session.flowId,
          newFlowId: keywordFlow.id,
        });
        queueFlowSessionSave(() => clearFlowSession(contact));
        session = null;
      }
      flow = keywordFlow;
      matchedText = candidate;
      matchSource = 'keyword';
      console.log('✅ Flow matched keyword trigger:', {
        flowId: flow.id,
        flowName: flow.name,
        projectId: flow.projectId,
        keyword: candidate,
      });
      break;
    }
  }

  if (!flow && session?.flowId) {
    flow = await Flow.findOne({
      where: { id: session.flowId },
    });
    if (!flow) {
      queueFlowSessionSave(() => clearFlowSession(contact));
      session = null;
    } else if (
      projectId &&
      flow.projectId &&
      Number(flow.projectId) !== Number(projectId)
    ) {
      console.log('🔄 Clearing flow session — flow belongs to different project:', {
        contactId: contact.id,
        sessionFlowId: flow.id,
        sessionFlowProjectId: flow.projectId,
        inboundProjectId: projectId,
      });
      queueFlowSessionSave(() => clearFlowSession(contact));
      flow = null;
      session = null;
    } else {
      matchSource = 'session';
    }
  }

  if (!flow) {
    return { handled: false, reason: 'no_matching_flow' };
  }

  const flowData = parseFlowData(flow);

  if (session?.currentNodeId && matchSource === 'session') {
    const startNodeId = findStartNodeId(flowData.nodes || []);
    if (startNodeId && String(session.currentNodeId) === String(startNodeId)) {
      const startNode = (flowData.nodes || []).find((n) => n.type === 'start');
      for (const candidate of texts) {
        if (matchesStartTrigger(startNode?.data || {}, candidate)) {
          console.log('🔄 Flow keyword restart from session on Flow Start:', {
            flowId: flow.id,
            keyword: candidate,
          });
          queueFlowSessionSave(() => clearFlowSession(contact));
          session = null;
          matchSource = 'keyword';
          matchedText = candidate;
          break;
        }
      }
    }
  }

  logWebhook(
    'WEBHOOK_FLOW_MATCHED',
    {
      ...flowResultMeta(flow, matchSource),
      flowProjectId: flow.projectId ?? null,
      flowStatus: flow.status || null,
      contactId: contact.id,
      projectId: projectId || contact.projectId || null,
      matchedText,
      replyCandidates: texts,
      templateButtonWaitNodeId: templateButtonWaitNodeId || null,
      sessionNodeId: session?.currentNodeId || null,
      inboundKind,
      inboundPhoneNumberId: replyPhoneNumberId,
    },
    null,
    { status: 'resolved' }
  );

  const flowProjectId = projectId || flow.projectId || contact.projectId || null;

  const dispatchFlowOutputs = async (output) => {
    const { results, sentCount } = await sendFlowOutputs({
      phone,
      userId: flowUserId,
      projectId: flowProjectId,
      contactId: contact.id,
      output,
      preferredPhoneNumberId: replyPhoneNumberId,
    });
    return { results, sentCount, outputCount: (output || []).length };
  };

  const persistFlowSession = (nodeId) => {
    queueFlowSessionSave(() =>
      saveFlowSession(contact, {
        flowId: flow.id,
        currentNodeId: nodeId,
        projectId: flowProjectId,
        phoneNumberId: replyPhoneNumberId,
      })
    );
  };

  // Template button tap after broadcast / no saved session — continue flow without re-sending template
  if (templateButtonWaitNodeId) {
    if (!isButtonTapInbound(inboundKind)) {
      return { handled: false, reason: 'awaiting_button_click', ...flowResultMeta(flow, matchSource) };
    }

    const templateResume = resolveFlowResumeFromButtonReply(
      flowData,
      texts,
      templateButtonWaitNodeId
    );
    if (!templateResume.matched || !String(templateResume.userInput || '').trim()) {
      console.warn('[flow] button_reply_not_matched (template button):', {
        flowId: flow.id,
        flowName: flow.name,
        waitNodeId: templateButtonWaitNodeId,
        candidates: texts,
        inboundKind,
      });
      return {
        handled: false,
        reason: 'button_reply_not_matched',
        ...flowResultMeta(flow, matchSource, { waitNodeId: templateButtonWaitNodeId }),
      };
    }
    const result = runFlow(flowData, {
      userInput: templateResume.userInput,
      currentNodeId: templateResume.waitNodeId,
    });

    const sendMeta = await dispatchFlowOutputs(result.output);
    const handled = isFlowDispatchHandled(sendMeta);

    if (result.done) {
      queueFlowSessionSave(() => clearFlowSession(contact));
      return {
        handled,
        ...flowResultMeta(flow, matchSource),
        matchedText: templateResume.userInput,
        continued: true,
        fromTemplateButton: true,
        done: true,
        outputCount: sendMeta.outputCount,
        sentCount: sendMeta.sentCount,
        reason: handled ? undefined : 'send_failed',
      };
    }

    await persistFlowSession(result.nextNodeId);

    return {
      handled,
      ...flowResultMeta(flow, matchSource),
      matchedText: templateResume.userInput,
      continued: true,
      fromTemplateButton: true,
      nextNodeId: result.nextNodeId,
      done: false,
      outputCount: sendMeta.outputCount,
      sentCount: sendMeta.sentCount,
      reason: handled ? undefined : 'send_failed',
    };
  }

  if (!session) {
    const buttonResume = resolveFlowResumeFromButtonReply(flowData, texts, null);
    const hasButtonWait =
      matchSource !== 'keyword' &&
      buttonResume.waitNodeId &&
      texts.some((t) => findFlowWaitNodeByButtonReply(flowData, t));

    if (hasButtonWait) {
      if (!isButtonTapInbound(inboundKind)) {
        return { handled: false, reason: 'awaiting_button_click', ...flowResultMeta(flow, matchSource) };
      }
      if (!buttonResume.matched || !String(buttonResume.userInput || '').trim()) {
        console.warn('[flow] button_reply_not_matched (no session):', {
          flowId: flow.id,
          flowName: flow.name,
          waitNodeId: buttonResume.waitNodeId,
          candidates: texts,
          inboundKind,
        });
        return {
          handled: false,
          reason: 'button_reply_not_matched',
          ...flowResultMeta(flow, matchSource, { waitNodeId: buttonResume.waitNodeId }),
        };
      }

      const result = runFlow(flowData, {
        userInput: buttonResume.userInput,
        currentNodeId: buttonResume.waitNodeId,
      });

      console.log('▶️ Flow button continue (no saved session):', {
        flowId: flow.id,
        waitNodeId: buttonResume.waitNodeId,
        userInput: buttonResume.userInput,
        outputTypes: (result.output || []).map((o) => o.type),
        nextNodeId: result.nextNodeId,
      });

      const sendMeta = await dispatchFlowOutputs(result.output);
      const handled = isFlowDispatchHandled(sendMeta);

      if (result.done) {
        queueFlowSessionSave(() => clearFlowSession(contact));
        return {
          handled,
          ...flowResultMeta(flow, matchSource),
          matchedText: buttonResume.userInput,
          continued: true,
          fromButtonReply: true,
          done: true,
          sentCount: sendMeta.sentCount,
          reason: handled ? undefined : 'send_failed',
        };
      }

      await persistFlowSession(result.nextNodeId);

      return {
        handled,
        ...flowResultMeta(flow, matchSource),
        matchedText: buttonResume.userInput,
        continued: true,
        fromButtonReply: true,
        nextNodeId: result.nextNodeId,
        done: false,
        sentCount: sendMeta.sentCount,
        reason: handled ? undefined : 'send_failed',
      };
    }

    const keywordStartInput = matchSource === 'keyword' ? matchedText : undefined;
    const startResult = runFlow(flowData, {
      userInput: keywordStartInput,
      currentNodeId: null,
      entryViaKeyword: matchSource === 'keyword',
    });
    if (matchSource === 'keyword') {
      console.log('▶️ Flow keyword start:', {
        flowId: flow.id,
        matchedText,
        outputTypes: (startResult.output || []).map((o) => o.type),
        nextNodeId: startResult.nextNodeId,
        done: startResult.done,
      });
    }
    const sendMeta = await dispatchFlowOutputs(startResult.output);
    const handled = isFlowDispatchHandled(sendMeta);

    if (startResult.done) {
      queueFlowSessionSave(() => clearFlowSession(contact));
      return {
        handled,
        ...flowResultMeta(flow, matchSource),
        matchedText,
        started: true,
        done: true,
        sentCount: sendMeta.sentCount,
        reason: handled ? undefined : 'send_failed',
      };
    }

    await persistFlowSession(startResult.nextNodeId);
    return {
      handled,
      ...flowResultMeta(flow, matchSource),
      matchedText,
      started: true,
      nextNodeId: startResult.nextNodeId,
      done: false,
      sentCount: sendMeta.sentCount,
      reason: handled ? undefined : 'send_failed',
    };
  }

  const resume = resolveFlowResumeFromButtonReply(
    flowData,
    texts,
    session.currentNodeId
  );

  if (
    isFlowButtonWaitNode(flowData, session.currentNodeId) &&
    !isButtonTapInbound(inboundKind)
  ) {
    return {
      handled: false,
      reason: 'awaiting_button_click',
      ...flowResultMeta(flow, matchSource, { sessionNodeId: session.currentNodeId }),
    };
  }

  if (
    isFlowButtonWaitNode(flowData, session.currentNodeId) &&
    (!resume.matched || !String(resume.userInput || '').trim())
  ) {
    console.warn('[flow] button_reply_not_matched (session):', {
      flowId: flow.id,
      flowName: flow.name,
      sessionNodeId: session.currentNodeId,
      candidates: texts,
      inboundKind,
    });
    return {
      handled: false,
      reason: 'button_reply_not_matched',
      ...flowResultMeta(flow, matchSource, { sessionNodeId: session.currentNodeId }),
    };
  }

  console.log('▶️ Flow session continue:', {
    flowId: flow.id,
    sessionNodeId: session.currentNodeId,
    resumeNodeId: resume.waitNodeId,
    userInput: resume.userInput,
    candidates: texts,
  });

  const result = runFlow(flowData, {
    userInput: resume.userInput,
    currentNodeId: resume.waitNodeId,
  });

  console.log('▶️ Flow session result:', {
    outputTypes: (result.output || []).map((o) => o.type),
    nextNodeId: result.nextNodeId,
    done: result.done,
  });

  const sendMeta = await dispatchFlowOutputs(result.output);
  const handled = isFlowDispatchHandled(sendMeta);

  if (result.done) {
    queueFlowSessionSave(() => clearFlowSession(contact));
    return {
      handled,
      ...flowResultMeta(flow, matchSource),
      matchedText,
      continued: true,
      done: true,
      sentCount: sendMeta.sentCount,
      reason: handled ? undefined : 'send_failed',
    };
  }

  await persistFlowSession(result.nextNodeId);

  return {
    handled,
    ...flowResultMeta(flow, matchSource),
    matchedText: resume.userInput,
    continued: true,
    nextNodeId: result.nextNodeId,
    done: false,
    sentCount: sendMeta.sentCount,
    reason: handled ? undefined : 'send_failed',
  };
}

module.exports = {
  handleInboundFlowMessage,
  sendFlowOutputs,
  sendFlowStep,
  findMatchingFlow,
  sendTemplateActionFollowUps,
  seedFlowSessionForCampaignTemplate,
  findFlowForCampaignTemplate,
};
