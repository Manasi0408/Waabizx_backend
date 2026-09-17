function isActualTemplateSend(msg) {
  if (!msg) return false;
  if (msg.isTemplate || msg.isTemplateSend) return true;
  const content = String(msg.content || msg.message || '').trim();
  if (/^Template:\s*\S+/i.test(content)) return true;
  if (/^\[Template\]\s*\S+/i.test(content)) return true;
  const mt = String(msg.messageType || msg.mediaType || '').toLowerCase();
  return mt === 'template';
}

function messageHasTemplateCard(msg) {
  return isActualTemplateSend(msg) && Boolean(msg?.templatePreview || msg?.templateName);
}

function mergeInboxMessages(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const templatePrimary = isActualTemplateSend(primary) ? primary : null;
  const templateSecondary = isActualTemplateSend(secondary) ? secondary : null;
  const templateSource =
    [templatePrimary, templateSecondary].find((m) => m?.templatePreview) ||
    templatePrimary ||
    templateSecondary;

  const previewA = templatePrimary?.templatePreview || null;
  const previewB = templateSecondary?.templatePreview || null;
  const mergedPreview =
    previewA && previewB
      ? {
          ...previewB,
          ...previewA,
          body: previewA.body || previewB.body || '',
          footer: previewA.footer || previewB.footer || '',
          headerImageUrl:
            previewA.headerImageUrl ||
            previewA.header?.url ||
            previewB.headerImageUrl ||
            previewB.header?.url ||
            null,
          header:
            previewA.header ||
            previewB.header ||
            null,
          buttons:
            (Array.isArray(previewA.buttons) && previewA.buttons.length ? previewA.buttons : null) ||
            previewB.buttons ||
            [],
        }
      : previewA || previewB || null;

  const headerImageUrl =
    mergedPreview?.headerImageUrl ||
    mergedPreview?.header?.url ||
    primary.mediaUrl ||
    secondary.mediaUrl ||
    null;

  return {
    ...primary,
    ...secondary,
    id: primary.id || secondary.id,
    content: templateSource?.content || mergedPreview?.body || primary.content || secondary.content,
    isTemplate: Boolean(templatePrimary || templateSecondary),
    isTemplateSend: Boolean(primary.isTemplateSend || secondary.isTemplateSend),
    templateName: templatePrimary?.templateName || templateSecondary?.templateName || null,
    templatePreview: mergedPreview,
    mediaUrl: headerImageUrl || primary.mediaUrl || secondary.mediaUrl || null,
    waMessageId: primary.waMessageId || secondary.waMessageId || null,
    status: primary.status || secondary.status,
    sentAt: primary.sentAt || secondary.sentAt || primary.createdAt || secondary.createdAt,
    createdAt: primary.createdAt || secondary.createdAt,
    source: templatePrimary?.templatePreview
      ? primary.source
      : templateSecondary?.templatePreview
        ? secondary.source
        : primary.source || secondary.source,
  };
}

function normalizeDedupeContent(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function getTemplatePreviewBody(msg) {
  const preview = msg?.templatePreview || msg?.templateSnapshot;
  return normalizeDedupeContent(preview?.body || '');
}

function messagesMatchForDedupe(a, b) {
  if (!a || !b) return false;
  const typeA = String(a.type || '');
  const typeB = String(b.type || '');
  if (typeA !== typeB) return false;

  const timeA = new Date(a.sentAt || a.createdAt || 0).getTime();
  const timeB = new Date(b.sentAt || b.createdAt || 0).getTime();
  const timeDiff = Math.abs(timeA - timeB);

  if (a.waMessageId && b.waMessageId && a.waMessageId === b.waMessageId) return true;

  const contentA = normalizeDedupeContent(a.content || a.message);
  const contentB = normalizeDedupeContent(b.content || b.message);

  if (contentA.length >= 2 && contentA === contentB && timeDiff <= 15000) return true;

  const templateA = isActualTemplateSend(a);
  const templateB = isActualTemplateSend(b);
  if (!templateA && !templateB) return false;

  const previewA = getTemplatePreviewBody(a);
  const previewB = getTemplatePreviewBody(b);
  const windowMs = templateA || templateB ? 60000 : 15000;
  if (timeDiff > windowMs) return false;

  if (previewA && contentB && previewA === contentB) return true;
  if (previewB && contentA && previewB === contentA) return true;
  if (previewA && previewB && previewA === previewB) return true;

  return false;
}

function dedupeInboxMessages(messages) {
  const result = [];

  for (const msg of messages) {
    let duplicateIdx = -1;

    if (msg.waMessageId) {
      duplicateIdx = result.findIndex((existing) => existing.waMessageId === msg.waMessageId);
    }

    if (duplicateIdx === -1) {
      duplicateIdx = result.findIndex((existing) => messagesMatchForDedupe(existing, msg));
    }

    if (duplicateIdx === -1) {
      result.push(msg);
    } else {
      result[duplicateIdx] = mergeInboxMessages(result[duplicateIdx], msg);
    }
  }

  return result.sort((a, b) => {
    const dateA = new Date(a.sentAt || a.createdAt || 0);
    const dateB = new Date(b.sentAt || b.createdAt || 0);
    return dateA - dateB;
  });
}

module.exports = {
  mergeInboxMessages,
  dedupeInboxMessages,
  messageHasTemplateCard,
  isActualTemplateSend,
  messagesMatchForDedupe,
};
