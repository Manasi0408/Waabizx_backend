const {
  parseTemplateSnapshot,
  buildClientTemplatePreview,
  enrichPreviewHeader,
  isTemplateMarkerContent,
  mergeTemplatePreviewWithCatalog,
  buildTemplateCatalogMap,
  extractHeaderMediaFromWaComponents,
  extractCarouselMediaFromWaComponents,
  hydrateCarouselPreviewMedia,
  finalizeTemplateSnapshotForInbox,
} = require('./templatePreviewUtil');
const {
  extractMediaIdFromPayload,
  ensureMediaUrlForInboxRow,
} = require('../services/metaMediaService');
const {
  toPermanentUploadPath,
  toPublicMediaUrl,
} = require('./templateMessageComponents');

function parseRowPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function extractTemplateNameFromBody(body) {
  const text = String(body || '').trim();
  let m = text.match(/^Template:\s*(.+)$/i);
  if (m) return m[1].trim();
  m = text.match(/^\[Template\]\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Build full API message object — never strip payload fields.
 * Layer 3 fix: API must return type + nested image/template/interactive objects.
 */
async function enrichInboxMessageForClient(im, { projectId, userId, templateByName }) {
  const body = String(im.message || '').trim();
  const payload = parseRowPayload(im.payload);
  const payloadType = String(payload?.type || im.type || 'text').toLowerCase();
  const payloadErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const firstPayloadError = payloadErrors[0] || null;
  const isFailed = String(im.status || '').toLowerCase() === 'failed';
  const deliveryError = isFailed
    ? payload?.error ||
      im.errorMessage ||
      firstPayloadError?.title ||
      firstPayloadError?.message ||
      firstPayloadError?.error_data?.details ||
      null
    : null;
  const deliveryErrorCode =
    firstPayloadError?.code != null
      ? String(firstPayloadError.code)
      : payload?.error_code != null
        ? String(payload.error_code)
        : null;
  const looksLikeUrl = /^https?:\/\//i.test(body) || body.startsWith('/uploads/');

  const isTemplate =
    !!im.isTemplateSend ||
    /^Template:\s*\S+/i.test(body) ||
    /^\[Template\]\s*\S+/i.test(body);

  let templateName = im.templateName || extractTemplateNameFromBody(body) || null;
  const rawTemplateSnapshot = parseTemplateSnapshot(im.templateSnapshot);
  let templatePreview = rawTemplateSnapshot ? { ...rawTemplateSnapshot } : null;
  const templateRecord = templateName
    ? templateByName?.get(String(templateName).toLowerCase())
    : null;

  if (isTemplate && templateName && templateRecord) {
    templatePreview = mergeTemplatePreviewWithCatalog(
      templatePreview,
      templateRecord,
      templateRecord.content || body || '',
      {
        templateName,
        body: isTemplateMarkerContent(body) ? null : body,
        templateParams: [],
      }
    );
  } else if (!templatePreview && isTemplate && templateName && templateRecord) {
    templatePreview = buildClientTemplatePreview(templateRecord, templateRecord.content || '', {
      templateName,
      body: isTemplateMarkerContent(body) ? null : body,
      templateParams: [],
    });
  }

  if (isTemplate) {
    templatePreview = hydrateCarouselPreviewMedia(templatePreview, rawTemplateSnapshot);
  }

  if (isTemplate && payload?.template?.components) {
    const fromPayload = extractHeaderMediaFromWaComponents(payload.template.components);
    const fromCarousel = extractCarouselMediaFromWaComponents(payload.template.components);
    templatePreview = finalizeTemplateSnapshotForInbox(
      templatePreview || { body: '', footer: '', buttons: [] },
      payload.template.components,
      fromPayload.headerImageUrl || im.mediaUrl || null
    );
    if (fromCarousel) {
      templatePreview = hydrateCarouselPreviewMedia(
        { ...(templatePreview || {}), ...fromCarousel },
        rawTemplateSnapshot || templatePreview
      );
    }
  }

  if (
    isTemplate &&
    templatePreview &&
    !templatePreview.isCarousel &&
    String(templateRecord?.variables?.templateType || '').toLowerCase() === 'carousel'
  ) {
    templatePreview = hydrateCarouselPreviewMedia(
      buildClientTemplatePreview(templateRecord, templateRecord?.content || body || '', {
        templateName,
        body: isTemplateMarkerContent(body) ? null : body,
      }),
      rawTemplateSnapshot
    );
  }

  if (isTemplate && templatePreview) {
    templatePreview = await enrichPreviewHeader(templatePreview, {
      templateName,
      projectId,
      templateRecord,
    });
    templatePreview = hydrateCarouselPreviewMedia(templatePreview, rawTemplateSnapshot);
  }

  if (isTemplate && im.mediaUrl && !templatePreview?.isCarousel) {
    const persistedMediaUrl = String(im.mediaUrl).trim();
    if (persistedMediaUrl) {
      const permanentPath = toPermanentUploadPath(persistedMediaUrl);
      const persistedDisplay =
        (permanentPath ? toPublicMediaUrl(permanentPath) : null) ||
        toPublicMediaUrl(persistedMediaUrl) ||
        persistedMediaUrl;
      const existingUrl =
        templatePreview?.headerImageUrl || templatePreview?.header?.url || null;
      const existingPermanent = existingUrl ? toPermanentUploadPath(existingUrl) : null;
      const preferPersisted =
        Boolean(permanentPath) || !existingUrl || !existingPermanent;
      if (preferPersisted && persistedDisplay) {
        const fmt = String(templatePreview?.headerFormat || 'IMAGE').toUpperCase();
        const headerType =
          fmt === 'VIDEO' ? 'video' : fmt === 'DOCUMENT' ? 'document' : 'image';
        templatePreview = {
          ...(templatePreview || { body: '', footer: '', buttons: [] }),
          headerImageUrl: persistedDisplay,
          header: { type: headerType, url: persistedDisplay },
          headerFormat: templatePreview?.headerFormat || fmt || 'IMAGE',
        };
      }
    }
  }

  const messageType = isTemplate ? 'template' : payloadType;
  const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(messageType);

  let mediaUrl =
    im.mediaUrl ||
    (isMedia && looksLikeUrl ? body : null) ||
    templatePreview?.headerImageUrl ||
    templatePreview?.header?.url ||
    null;

  if (isTemplate && im.mediaUrl && !mediaUrl) {
    mediaUrl = String(im.mediaUrl).trim() || null;
  }

  if (!mediaUrl && isMedia && payload) {
    try {
      const resolved = await ensureMediaUrlForInboxRow(im, { userId, projectId });
      if (resolved) {
        mediaUrl = resolved;
        const InboxMessageModel = require('../models/InboxMessage');
        InboxMessageModel.update({ mediaUrl: resolved }, { where: { id: im.id } }).catch(() => {});
      }
    } catch (mediaErr) {
      console.warn('ensureMediaUrlForInboxRow:', mediaErr?.message || mediaErr);
    }
  }

  const mediaId = extractMediaIdFromPayload(payload);
  if (!mediaUrl && isMedia && mediaId) {
    mediaUrl = `/api/media/whatsapp/${encodeURIComponent(mediaId)}`;
  }
  const caption = isMedia && !looksLikeUrl ? body : '';

  const templateHeader = isTemplate && templatePreview
    ? templatePreview.header ||
      (templatePreview.headerImageUrl
        ? { type: 'image', url: templatePreview.headerImageUrl }
        : templatePreview.headerText
          ? { type: 'text', text: templatePreview.headerText }
          : null)
    : null;

  return {
    id: `inbox_${im.id}`,
    messageId: im.waMessageId || payload?.id || null,
    waMessageId: im.waMessageId,
    direction: im.direction,
    type: im.direction === 'incoming' ? 'incoming' : 'outgoing',
    messageType,
    mediaType: messageType,
    content: isTemplate
      ? templatePreview?.body || (isTemplateMarkerContent(body) ? '' : body)
      : isMedia && looksLikeUrl
        ? ''
        : caption || body,
    status: im.status,
    errorMessage: deliveryError,
    errorCode: deliveryErrorCode,
    error_code: deliveryErrorCode,
    sentAt: im.timestamp || im.createdAt,
    createdAt: im.createdAt,
    updatedAt: im.updatedAt,
    source: 'inbox_message',
    isTemplate,
    isTemplateSend: !!im.isTemplateSend,
    templateName,
    templatePreview,
    templateSnapshot: templatePreview,
    header: templateHeader,
    footer: isTemplate ? (templatePreview?.footer || '') : undefined,
    buttons: isTemplate && Array.isArray(templatePreview?.buttons) ? templatePreview.buttons : undefined,
    mediaUrl,
    mediaId,
    mediaFilename:
      payload?.document?.filename || payload?.video?.filename || null,
    mimeType:
      payload?.image?.mime_type ||
      payload?.video?.mime_type ||
      payload?.audio?.mime_type ||
      payload?.document?.mime_type ||
      null,
    payload,
    image: payload?.image || null,
    video: payload?.video || null,
    audio: payload?.audio || null,
    document: payload?.document || null,
    interactive: payload?.interactive || null,
    button: payload?.button || null,
    location: payload?.location || null,
    contacts: payload?.contacts || null,
    selectedOption:
      payload?.button?.text ||
      payload?.interactive?.button_reply?.title ||
      payload?.interactive?.list_reply?.title ||
      null,
    interactiveType: payload?.interactive?.type || (payload?.button ? 'button_reply' : null),
    latitude: payload?.location?.latitude,
    longitude: payload?.location?.longitude,
    locationName: payload?.location?.name || null,
    locationAddress: payload?.location?.address || null,
  };
}

module.exports = {
  enrichInboxMessageForClient,
  extractTemplateNameFromBody,
  parseRowPayload,
};
