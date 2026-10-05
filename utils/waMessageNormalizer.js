const { extractInboundText } = require('./inboundMessageParser');
const { extractMediaIdFromPayload } = require('../services/metaMediaService');
const { toPublicMediaUrl } = require('./templateMessageComponents');

function resolvePublicMediaUrl(url) {
  return toPublicMediaUrl(url) || String(url || '').trim() || null;
}

function mapMessageTypeToInboxEnum(messageType) {
  const t = String(messageType || 'text').toLowerCase();
  if (['image', 'video', 'audio', 'document'].includes(t)) return t;
  return 'text';
}

function buildInboxRecordFromWebhook(messageObj, contact, userId, projectId, timestamp, text) {
  const normalized = normalizeWebhookMessage(messageObj, {
    direction: 'incoming',
    status: 'delivered',
    timestamp: timestamp || new Date(),
    from: contact?.phone,
    waMessageId: messageObj?.id || null,
  });
  const displayText = normalized.content || text || '';
  return {
    contactId: contact.id,
    userId,
    projectId: contact.projectId || projectId || null,
    direction: 'incoming',
    message: displayText,
    type: mapMessageTypeToInboxEnum(normalized.messageType),
    status: 'delivered',
    timestamp: timestamp || new Date(),
    waMessageId: messageObj?.id || null,
    payload: JSON.stringify(messageObj),
  };
}

function buildSocketMessagePayload(normalized, extras = {}) {
  const payload = normalized.payload || null;
  const messageType = normalized.messageType || 'text';
  const mediaId =
    normalized.mediaId ||
    payload?.image?.id ||
    payload?.video?.id ||
    payload?.audio?.id ||
    payload?.document?.id ||
    payload?.sticker?.id ||
    null;

  return {
    id: extras.id,
    contactId: extras.contactId,
    conversationId: extras.conversationId,
    phone: extras.phone,
    waMessageId: normalized.messageId || extras.waMessageId || payload?.id || null,
    content: normalized.content || extras.content || '',
    message: normalized.content || extras.content || '',
    type: 'incoming',
    direction: 'inbound',
    sender: 'customer',
    messageType,
    mediaType: messageType,
    status: normalized.status || 'delivered',
    sentAt: extras.sentAt,
    createdAt: extras.createdAt,
    created_at: extras.createdAt,
    mediaUrl: extras.mediaUrl || null,
    mediaId,
    mediaFilename: normalized.mediaFilename || null,
    mimeType: normalized.mimeType || null,
    payload,
    image: payload?.image || null,
    video: payload?.video || null,
    audio: payload?.audio || null,
    document: payload?.document || null,
    selectedOption: normalized.selectedOption || null,
    interactiveType: normalized.interactiveType || null,
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    locationName: normalized.locationName,
    source: 'webhook',
  };
}

/**
 * Normalize a Meta WhatsApp webhook message object into a canonical stored shape.
 * Always keeps the full raw payload — never text-only.
 */
function normalizeWebhookMessage(messageObj, extras = {}) {
  if (!messageObj || typeof messageObj !== 'object') {
    return {
      messageId: extras.waMessageId || null,
      direction: extras.direction || 'inbound',
      messageType: 'text',
      content: '',
      status: extras.status || 'delivered',
      timestamp: extras.timestamp || new Date().toISOString(),
      from: extras.from || null,
      payload: messageObj || {},
    };
  }

  const waType = String(messageObj.type || 'text').toLowerCase();
  const base = {
    messageId: messageObj.id || extras.waMessageId || null,
    direction: extras.direction || 'inbound',
    status: extras.status || 'delivered',
    timestamp: extras.timestamp || new Date().toISOString(),
    from: extras.from || null,
    payload: messageObj,
  };

  switch (waType) {
    case 'text':
      return {
        ...base,
        messageType: 'text',
        content: messageObj.text?.body || '',
      };

    case 'image':
      return {
        ...base,
        messageType: 'image',
        content: messageObj.image?.caption || '',
        mediaId: messageObj.image?.id || null,
        mimeType: messageObj.image?.mime_type || null,
        sha256: messageObj.image?.sha256 || null,
      };

    case 'video':
      return {
        ...base,
        messageType: 'video',
        content: messageObj.video?.caption || '',
        mediaId: messageObj.video?.id || null,
        mimeType: messageObj.video?.mime_type || null,
        mediaFilename: messageObj.video?.filename || 'video.mp4',
      };

    case 'audio':
      return {
        ...base,
        messageType: 'audio',
        content: '',
        mediaId: messageObj.audio?.id || null,
        mimeType: messageObj.audio?.mime_type || null,
        voice: Boolean(messageObj.audio?.voice),
      };

    case 'document':
      return {
        ...base,
        messageType: 'document',
        content: messageObj.document?.caption || '',
        mediaId: messageObj.document?.id || null,
        mimeType: messageObj.document?.mime_type || null,
        mediaFilename: messageObj.document?.filename || 'document',
      };

    case 'sticker':
      return {
        ...base,
        messageType: 'sticker',
        content: '',
        mediaId: messageObj.sticker?.id || null,
        mimeType: messageObj.sticker?.mime_type || 'image/webp',
      };

    case 'location':
      return {
        ...base,
        messageType: 'location',
        content: messageObj.location?.name || messageObj.location?.address || 'Location',
        latitude: messageObj.location?.latitude,
        longitude: messageObj.location?.longitude,
        locationName: messageObj.location?.name || null,
        locationAddress: messageObj.location?.address || null,
      };

    case 'contacts':
      return {
        ...base,
        messageType: 'contact',
        content: messageObj.contacts?.[0]?.name?.formatted_name || 'Contact',
        contacts: messageObj.contacts || [],
      };

    case 'button':
      return {
        ...base,
        messageType: 'interactive',
        interactiveType: 'template_quick_reply',
        content: messageObj.button?.text || messageObj.button?.payload || '',
        selectedOption: messageObj.button?.text || messageObj.button?.payload || '',
      };

    case 'interactive': {
      const interactive = messageObj.interactive || {};
      const iType = String(interactive.type || '').toLowerCase();

      if (iType === 'button') {
        return {
          ...base,
          messageType: 'interactive',
          interactiveType: 'button',
          content: interactive.body?.text || '',
        };
      }
      if (iType === 'list') {
        return {
          ...base,
          messageType: 'list',
          interactiveType: 'list',
          content: interactive.body?.text || '',
        };
      }
      if (iType === 'cta_url') {
        return {
          ...base,
          messageType: 'interactive',
          interactiveType: 'cta_url',
          content: interactive.body?.text || '',
        };
      }

      if (iType === 'list_reply') {
        return {
          ...base,
          messageType: 'list',
          interactiveType: 'list_reply',
          content: interactive.list_reply?.title || interactive.list_reply?.id || '',
          selectedOption: interactive.list_reply?.title || '',
          listId: interactive.list_reply?.id || null,
        };
      }
      if (iType === 'nfm_reply') {
        return {
          ...base,
          messageType: 'flow',
          interactiveType: 'flow',
          content: interactive.nfm_reply?.body || 'Flow response',
          flowResponse: interactive.nfm_reply?.response_json || null,
        };
      }
      return {
        ...base,
        messageType: 'interactive',
        interactiveType: 'button_reply',
        content:
          interactive.button_reply?.title ||
          interactive.button_reply?.id ||
          extractInboundText(messageObj),
        selectedOption: interactive.button_reply?.title || '',
      };
    }

    case 'template':
      return {
        ...base,
        messageType: 'template',
        content: extractInboundText(messageObj) || '[template]',
        isTemplateSend: true,
      };

    default:
      return {
        ...base,
        messageType: waType || 'text',
        content: extractInboundText(messageObj) || `[${waType}]`,
      };
  }
}

function parseStoredPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function resolveInboxRowMediaUrl(plain, payload, templatePreview) {
  const fromColumn = plain?.mediaUrl ? resolvePublicMediaUrl(plain.mediaUrl) || String(plain.mediaUrl).trim() : null;
  if (fromColumn) return fromColumn;

  const fromSnapshot =
    templatePreview?.headerImageUrl ||
    templatePreview?.header?.url ||
    null;
  if (fromSnapshot) return resolvePublicMediaUrl(fromSnapshot) || fromSnapshot;

  if (payload && typeof payload === 'object') {
    const payloadType = String(payload.type || '').toLowerCase();
    if (payloadType === 'image') {
      return resolvePublicMediaUrl(payload.image?.link) || payload.image?.link || null;
    }
    if (payloadType === 'video') {
      return resolvePublicMediaUrl(payload.video?.link) || payload.video?.link || null;
    }
    if (payloadType === 'interactive' && payload.interactive?.header) {
      const headerType = String(payload.interactive.header.type || '').toLowerCase();
      if (headerType === 'image') {
        return (
          resolvePublicMediaUrl(payload.interactive.header.image?.link) ||
          payload.interactive.header.image?.link ||
          null
        );
      }
      if (headerType === 'video') {
        return (
          resolvePublicMediaUrl(payload.interactive.header.video?.link) ||
          payload.interactive.header.video?.link ||
          null
        );
      }
    }
    const templateComponents = payload?.template?.components;
    if (Array.isArray(templateComponents)) {
      for (const comp of templateComponents) {
        if (String(comp?.type || '').toLowerCase() !== 'header') continue;
        for (const param of comp.parameters || []) {
          const link = param?.image?.link || param?.video?.link;
          if (link) return resolvePublicMediaUrl(link) || link;
        }
      }
    }
  }

  return null;
}

function inboxRowToClientMessage(row) {
  const plain = row?.get ? row.get({ plain: true }) : { ...row };
  const payload = parseStoredPayload(plain.payload);
  const normalized = payload
    ? normalizeWebhookMessage(payload, {
        waMessageId: plain.waMessageId,
        direction: plain.direction,
        status: plain.status,
        timestamp: plain.timestamp || plain.createdAt,
      })
    : null;

  const msgType = normalized?.messageType || String(plain.type || 'text').toLowerCase();
  const body = String(plain.message || '').trim();
  const looksLikeUrl = /^https?:\/\//i.test(body) || body.startsWith('/uploads/');
  const isTemplateMarker =
    /^Template:\s*\S+/i.test(body) || /^\[Template\]\s*\S+/i.test(body);

  const isTemplate = Boolean(plain.isTemplateSend);

  let templatePreview = null;
  try {
    if (plain.templateSnapshot) {
      templatePreview =
        typeof plain.templateSnapshot === 'string'
          ? JSON.parse(plain.templateSnapshot)
          : plain.templateSnapshot;
    }
  } catch {
    templatePreview = null;
  }

  const resolvedMediaUrl = resolveInboxRowMediaUrl(plain, payload, templatePreview);
  if (resolvedMediaUrl && templatePreview && isTemplate && !templatePreview.headerImageUrl) {
    templatePreview = {
      ...templatePreview,
      headerImageUrl: resolvedMediaUrl,
      header: templatePreview.header || { type: 'image', url: resolvedMediaUrl },
      headerFormat: templatePreview.headerFormat || 'IMAGE',
    };
  }
  const displayContent =
    isTemplate && templatePreview?.body
      ? templatePreview.body
      : isTemplate && isTemplateMarker
        ? ''
        : looksLikeUrl && msgType !== 'text'
          ? ''
          : body;

  return {
    id: `inbox_${plain.id}`,
    messageId: plain.waMessageId || normalized?.messageId || null,
    direction: plain.direction,
    type: plain.direction === 'incoming' ? 'incoming' : 'outgoing',
    messageType: isTemplate ? 'template' : msgType,
    content: displayContent,
    status: plain.status,
    sentAt: plain.timestamp || plain.createdAt,
    createdAt: plain.createdAt,
    waMessageId: plain.waMessageId,
    source: 'inbox_message',
    isTemplate: Boolean(plain.isTemplateSend),
    isTemplateSend: Boolean(plain.isTemplateSend),
    templateName: plain.templateName || null,
    templatePreview,
    mediaUrl: resolvedMediaUrl || (looksLikeUrl ? body : null) || templatePreview?.headerImageUrl || null,
    mediaId: extractMediaIdFromPayload(payload) || normalized?.mediaId || null,
    mediaFilename: normalized?.mediaFilename || null,
    payload: payload || normalized?.payload || null,
    image: payload?.image || null,
    video: payload?.video || null,
    audio: payload?.audio || null,
    document: payload?.document || null,
    interactive: payload?.interactive || null,
    button: payload?.button || null,
    location: payload?.location || null,
    latitude: normalized?.latitude,
    longitude: normalized?.longitude,
    locationName: normalized?.locationName,
    contacts: normalized?.contacts,
    selectedOption: normalized?.selectedOption,
    interactiveType: normalized?.interactiveType,
  };
}

module.exports = {
  normalizeWebhookMessage,
  parseStoredPayload,
  inboxRowToClientMessage,
  buildInboxRecordFromWebhook,
  buildSocketMessagePayload,
  mapMessageTypeToInboxEnum,
};
