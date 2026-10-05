const { Op } = require('sequelize');
const Campaign = require('../models/Campaign');
const {
  getTemplateComponents,
  extractButtonsFromComponents,
  toPublicMediaUrl,
  toPermanentUploadPath,
  resolveDisplayableHeaderMediaUrl,
  resolveHeaderImageFromComponents,
} = require('./templateMessageComponents');

function isTemplateMarkerContent(text) {
  const value = String(text || '').trim();
  return /^Template:\s*\S+/i.test(value) || /^\[Template\]\s*\S+/i.test(value);
}

function parseTemplateSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function applyTemplateParamsToBody(bodyText, params = []) {
  let text = String(bodyText || '');
  (params || []).forEach((param, idx) => {
    const n = idx + 1;
    const value = param == null ? '' : String(param);
    text = text.replace(new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`, 'g'), value);
  });
  return text.trim();
}

function buttonsFromTemplateVariables(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];

  if (Array.isArray(vars.interactiveButtons) && vars.interactiveButtons.length) {
    return vars.interactiveButtons
      .map((btn) => ({
        type: String(btn.type || 'QUICK_REPLY').toUpperCase(),
        text: String(btn.text || btn.label || btn.title || '').trim(),
        url: btn.url,
        phone_number: btn.phone_number || btn.phoneNumber,
      }))
      .filter((b) => b.text);
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
          buttons.push({ type: 'QUICK_REPLY', text: String(cta.label).trim() });
        } else if (cta.type === 'phone') {
          buttons.push({
            type: 'PHONE_NUMBER',
            text: String(cta.label).trim(),
            phone_number: String(cta.value || '').trim(),
          });
        } else {
          buttons.push({
            type: 'URL',
            text: String(cta.label).trim(),
            url: String(cta.value || '').trim(),
          });
        }
      });
  }

  if (showQr && Array.isArray(vars.quickReplies)) {
    vars.quickReplies
      .filter((a) => String(a?.label || a?.text || '').trim())
      .forEach((qr) => {
        buttons.push({
          type: 'QUICK_REPLY',
          text: String(qr.label || qr.text || qr).trim(),
        });
      });
  }

  return buttons.filter((b) => b.text);
}

function enrichTemplateRecordWithComponents(templateRecord, components) {
  if (!templateRecord) return templateRecord;
  const plain = templateRecord.get ? templateRecord.get({ plain: true }) : { ...templateRecord };
  const comps =
    Array.isArray(components) && components.length
      ? components
      : getTemplateComponents(plain);
  return {
    ...plain,
    components: comps,
    variables: {
      ...(plain.variables && typeof plain.variables === 'object' ? plain.variables : {}),
      ...(comps.length ? { components: comps } : {}),
    },
  };
}

function buildClientTemplatePreview(templateRecord, templateContent, overrides = {}) {
  if (!templateRecord && !overrides.body) return null;

  const components = templateRecord ? getTemplateComponents(templateRecord) : [];
  const header = components.find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  const footer = components.find((c) => String(c.type || '').toUpperCase() === 'FOOTER');
  const vars =
    templateRecord?.variables && typeof templateRecord.variables === 'object'
      ? templateRecord.variables
      : {};

  const headerFormat =
    (header?.format ? String(header.format).toUpperCase() : null) ||
    (vars.templateType === 'video'
      ? 'VIDEO'
      : vars.templateType === 'document'
        ? 'DOCUMENT'
        : vars.templateType === 'image'
          ? 'IMAGE'
          : null);

  const needsHeaderMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat || '');
  const headerImageUrl = needsHeaderMedia
      ? resolveDisplayableHeaderMediaUrl(
          overrides.headerImageUrl,
          overrides.header_media_url,
          vars.headerMediaUrl,
          vars.header_media_url,
          templateRecord?.headerMediaUrl,
          templateRecord?.header_media_url,
          resolveHeaderImageFromComponents(components)
        )
      : null;

  let buttons = extractButtonsFromComponents(components).map((btn, idx) => ({
    id: `btn_${idx}`,
    text: String(btn.text || btn.title || btn.label || '').trim(),
    type: btn.type || 'QUICK_REPLY',
    value: btn.text || btn.title || btn.label || '',
    url: btn.url || null,
    phone_number: btn.phone_number || null,
  }));

  if (!buttons.length) {
    buttons = buttonsFromTemplateVariables(vars).map((btn, idx) => ({
      id: `btn_${idx}`,
      text: String(btn.text || '').trim(),
      type: btn.type || 'QUICK_REPLY',
      value: btn.text || '',
      url: btn.url || null,
      phone_number: btn.phone_number || null,
    }));
  }

  const rawBody =
    overrides.body && !isTemplateMarkerContent(overrides.body) ? overrides.body : null;
  const body = String(
    rawBody ||
      applyTemplateParamsToBody(
        templateContent || templateRecord?.content || '',
        overrides.templateParams
      ) ||
      templateRecord?.content ||
      ''
  ).trim();

  const headerText =
    headerFormat === 'TEXT' && header?.text
      ? applyTemplateParamsToBody(
          header.text,
          overrides.headerParams || overrides.templateParams
        )
      : null;

  const headerObj = (() => {
    if (headerFormat === 'IMAGE' && headerImageUrl) {
      return { type: 'image', url: headerImageUrl };
    }
    if (headerFormat === 'VIDEO' && headerImageUrl) {
      return { type: 'video', url: headerImageUrl };
    }
    if (headerFormat === 'DOCUMENT' && headerImageUrl) {
      const filename = String(headerImageUrl).split('/').pop()?.split('?')[0] || 'document.pdf';
      return { type: 'document', url: headerImageUrl, filename };
    }
    if (headerFormat === 'TEXT' && headerText) {
      return { type: 'text', text: headerText };
    }
    if (headerImageUrl) {
      const type =
        headerFormat === 'VIDEO' ? 'video' : headerFormat === 'DOCUMENT' ? 'document' : 'image';
      return { type, url: headerImageUrl };
    }
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat || '')) {
      return { type: headerFormat === 'VIDEO' ? 'video' : headerFormat === 'DOCUMENT' ? 'document' : 'image' };
    }
    return null;
  })();

  const normalizedButtons = buttons.map((btn, idx) => ({
    id: btn.id || `btn_${idx}`,
    type: String(btn.type || 'QUICK_REPLY').toLowerCase().replace('phone_number', 'phone'),
    text: String(btn.text || '').trim(),
    value: btn.value || btn.text || '',
    url: btn.url || null,
    phone_number: btn.phone_number || null,
  }));

  const carouselComp = components.find((c) => String(c?.type || '').toUpperCase() === 'CAROUSEL');
  const isCarousel =
    String(vars.templateType || '').toLowerCase() === 'carousel' ||
    (Array.isArray(vars.carouselCards) && vars.carouselCards.length > 0) ||
    (Array.isArray(carouselComp?.cards) && carouselComp.cards.length > 0);
  let carouselMediaType = String(vars.carouselMediaType || 'IMAGE').toUpperCase();
  let carouselCards = [];
  if (isCarousel) {
    const cardMediaUrls = Array.isArray(overrides.carouselCardMediaUrls)
      ? overrides.carouselCardMediaUrls
      : [];
    const metaCards = Array.isArray(carouselComp?.cards) ? carouselComp.cards : [];
    if (metaCards.length) {
      carouselCards = metaCards.map((card, idx) => {
        const cardHeader = (card?.components || []).find(
          (c) => String(c?.type || '').toUpperCase() === 'HEADER'
        );
        if (cardHeader?.format) {
          carouselMediaType = String(cardHeader.format).toUpperCase();
        }
        const cardBody = (card?.components || []).find(
          (c) => String(c?.type || '').toUpperCase() === 'BODY'
        );
        const cardButtonsComp = (card?.components || []).find(
          (c) => String(c?.type || '').toUpperCase() === 'BUTTONS'
        );
        const cardButtons = (cardButtonsComp?.buttons || []).map((btn, bi) => ({
          id: `card_${idx}_btn_${bi}`,
          type: String(btn?.type || 'URL').toUpperCase(),
          text: String(btn?.text || btn?.title || '').trim(),
          url: btn?.url || null,
        }));
        const cardMediaUrl = cardMediaUrls[idx]
          ? toPublicMediaUrl(toPermanentUploadPath(cardMediaUrls[idx]) || cardMediaUrls[idx])
          : null;
        return {
          index: idx,
          body: String(cardBody?.text || '').trim(),
          buttons: cardButtons.filter((b) => b.text),
          headerImageUrl: cardMediaUrl,
        };
      });
    } else if (Array.isArray(vars.carouselCards)) {
      carouselCards = vars.carouselCards.map((card, idx) => ({
        index: idx,
        body: String(card?.body || '').trim(),
        buttons: Array.isArray(card?.buttons)
          ? card.buttons.map((btn, bi) => ({
              id: `card_${idx}_btn_${bi}`,
              type: 'URL',
              text: String(btn?.label || btn?.text || '').trim(),
              url: btn?.url || btn?.value || null,
            }))
          : [],
        headerImageUrl: cardMediaUrls[idx]
          ? toPublicMediaUrl(toPermanentUploadPath(cardMediaUrls[idx]) || cardMediaUrls[idx])
          : null,
      }));
    }
  }

  return {
    headerFormat,
    headerText,
    headerImageUrl,
    header: headerObj,
    body,
    footer: String(overrides.footer || footer?.text || vars.footer || '').trim(),
    buttons: normalizedButtons,
    templateName: overrides.templateName || templateRecord?.name || null,
    isCarousel,
    carouselMediaType: isCarousel ? carouselMediaType : null,
    carouselCards: isCarousel ? carouselCards : undefined,
  };
}

/**
 * Fill missing header/buttons/footer from template catalog when snapshot only has body.
 */
function mergeTemplatePreviewWithCatalog(snapshot, templateRecord, templateContent, overrides = {}) {
  const rebuilt = buildClientTemplatePreview(templateRecord, templateContent, overrides);
  if (!rebuilt && !snapshot) return null;
  if (!rebuilt) return snapshot;
  if (!snapshot) return rebuilt;

  const snapButtons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const rebuiltButtons = Array.isArray(rebuilt.buttons) ? rebuilt.buttons : [];

  const snapUrl = snapshot.headerImageUrl || snapshot.header?.url || null;
  const rebuiltUrl = rebuilt.headerImageUrl || rebuilt.header?.url || null;
  const preferCatalogPermanent =
    Boolean(toPermanentUploadPath(rebuiltUrl)) && !toPermanentUploadPath(snapUrl);
  const headerImageUrl = preferCatalogPermanent
    ? rebuiltUrl
    : snapUrl || rebuiltUrl || null;

  const snapCarousel = Array.isArray(snapshot.carouselCards) ? snapshot.carouselCards : [];
  const rebuiltCarousel = Array.isArray(rebuilt.carouselCards) ? rebuilt.carouselCards : [];
  const carouselCards =
    snapCarousel.length > 0
      ? snapCarousel.map((card, idx) => {
          const rebuiltCard = rebuiltCarousel[idx] || {};
          const snapUrl = card?.headerImageUrl || card?.headerMediaPath || null;
          const rebuiltUrl = rebuiltCard?.headerImageUrl || null;
          const snapPermanent = snapUrl ? toPermanentUploadPath(snapUrl) : null;
          const preferSnap = Boolean(snapPermanent) || Boolean(snapUrl && !rebuiltUrl);
          const raw = preferSnap ? snapUrl : rebuiltUrl || snapUrl;
          const permanent = toPermanentUploadPath(raw) || snapPermanent;
          const displayUrl = permanent
            ? toPublicMediaUrl(permanent)
            : toPublicMediaUrl(raw) || raw;
          return {
            ...rebuiltCard,
            ...card,
            body: String(card?.body || rebuiltCard?.body || '').trim(),
            buttons: Array.isArray(card?.buttons) && card.buttons.length ? card.buttons : rebuiltCard.buttons,
            headerImageUrl: displayUrl || card?.headerImageUrl || rebuiltCard?.headerImageUrl || null,
            headerMediaPath: permanent || card?.headerMediaPath || null,
          };
        })
      : rebuiltCarousel;

  const isCarousel = Boolean(snapshot.isCarousel || rebuilt.isCarousel);
  const carouselMediaType = snapshot.carouselMediaType || rebuilt.carouselMediaType || null;

  const merged = {
    ...rebuilt,
    ...snapshot,
    headerFormat: snapshot.headerFormat || rebuilt.headerFormat || null,
    headerText: snapshot.headerText || rebuilt.headerText || null,
    headerImageUrl,
    header: isCarousel
      ? snapshot.header || rebuilt.header || null
      : (headerImageUrl
          ? {
              type:
                String(snapshot.headerFormat || rebuilt.headerFormat || 'IMAGE').toUpperCase() === 'VIDEO'
                  ? 'video'
                  : String(snapshot.headerFormat || rebuilt.headerFormat || '').toUpperCase() === 'DOCUMENT'
                    ? 'document'
                    : 'image',
              url: headerImageUrl,
            }
          : null) ||
        snapshot.header ||
        rebuilt.header ||
        null,
    body: String(snapshot.body || rebuilt.body || '').trim(),
    footer: String(snapshot.footer || rebuilt.footer || '').trim(),
    buttons: snapButtons.length ? snapButtons : rebuiltButtons,
    templateName: snapshot.templateName || rebuilt.templateName || overrides.templateName || null,
    isCarousel,
    carouselMediaType,
    carouselCards: isCarousel ? carouselCards : undefined,
  };

  if (!isCarousel && !merged.header && merged.headerImageUrl) {
    merged.header = { type: 'image', url: merged.headerImageUrl };
  }
  if (!merged.headerImageUrl && merged.header?.url) {
    merged.headerImageUrl = merged.header.url;
  }
  if (!merged.headerFormat && merged.header?.type) {
    merged.headerFormat = String(merged.header.type).toUpperCase();
  }

  return merged;
}

/**
 * Extract header media/text from the actual WhatsApp template send components array.
 * This is the authoritative source — image.link from the payload that was sent to AiSensy/Meta.
 */
function normalizeCarouselCardDisplayUrl(raw) {
  if (!raw) return null;
  const permanent = toPermanentUploadPath(raw);
  if (permanent) return toPublicMediaUrl(permanent);
  return toPublicMediaUrl(raw) || resolveDisplayableHeaderMediaUrl(raw) || raw;
}

function extractCarouselMediaFromWaComponents(components) {
  const comps = Array.isArray(components) ? components : [];
  const carousel = comps.find((c) => String(c?.type || '').toUpperCase() === 'CAROUSEL');
  if (!Array.isArray(carousel?.cards) || !carousel.cards.length) return null;

  let carouselMediaType = 'IMAGE';
  const carouselCards = carousel.cards.map((card, idx) => {
    const inner = Array.isArray(card?.components) ? card.components : [];
    const header = inner.find((c) => String(c?.type || '').toUpperCase() === 'HEADER');
    const body = inner.find((c) => String(c?.type || '').toUpperCase() === 'BODY');
    const buttonsComp = inner.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS');
    const param = header?.parameters?.[0];
    const ptype = String(param?.type || '').toLowerCase();
    let headerImageUrl = null;
    if (ptype === 'video') {
      carouselMediaType = 'VIDEO';
      if (param?.video?.link) {
        headerImageUrl = normalizeCarouselCardDisplayUrl(param.video.link);
      } else if (param?.video?.id) {
        headerImageUrl = `/api/media/whatsapp/${encodeURIComponent(String(param.video.id))}`;
      }
    } else if (ptype === 'image') {
      carouselMediaType = 'IMAGE';
      if (param?.image?.link) {
        headerImageUrl = normalizeCarouselCardDisplayUrl(param.image.link);
      } else if (param?.image?.id) {
        headerImageUrl = `/api/media/whatsapp/${encodeURIComponent(String(param.image.id))}`;
      }
    }
    const buttons = (buttonsComp?.buttons || []).map((btn, bi) => ({
      id: `card_${idx}_btn_${bi}`,
      type: String(btn?.type || 'URL').toUpperCase(),
      text: String(btn?.text || btn?.title || '').trim(),
      url: btn?.url || null,
    }));
    return {
      index: card.card_index != null ? card.card_index : idx,
      body: String(body?.text || '').trim(),
      buttons: buttons.filter((b) => b.text),
      headerImageUrl,
      headerMediaPath: headerImageUrl ? toPermanentUploadPath(headerImageUrl) : null,
    };
  });

  return { isCarousel: true, carouselMediaType, carouselCards };
}

function hydrateCarouselPreviewMedia(preview, snapshotSource = null) {
  if (!preview && !snapshotSource) return preview;
  const base = preview ? { ...preview } : {};
  const src = snapshotSource && typeof snapshotSource === 'object' ? snapshotSource : {};
  const isCarousel =
    Boolean(base.isCarousel || src.isCarousel) ||
    String(base.carouselMediaType || src.carouselMediaType || '').length > 0 ||
    (Array.isArray(base.carouselCards) && base.carouselCards.length > 0) ||
    (Array.isArray(src.carouselCards) && src.carouselCards.length > 0);
  if (!isCarousel) return preview;

  const previewCards = Array.isArray(base.carouselCards) ? base.carouselCards : [];
  const srcCards = Array.isArray(src.carouselCards) ? src.carouselCards : [];
  const len = Math.max(previewCards.length, srcCards.length);
  if (!len) return { ...base, isCarousel: true };

  const carouselCards = Array.from({ length: len }, (_, idx) => {
    const card = previewCards[idx] || {};
    const snap = srcCards[idx] || {};
    const rawUrl =
      snap.headerImageUrl ||
      snap.headerMediaPath ||
      card.headerImageUrl ||
      card.headerMediaPath;
    const displayUrl = normalizeCarouselCardDisplayUrl(rawUrl);
    return {
      ...card,
      ...snap,
      index: snap.index != null ? snap.index : card.index != null ? card.index : idx,
      body: String(snap.body || card.body || '').trim(),
      buttons:
        Array.isArray(snap.buttons) && snap.buttons.length ? snap.buttons : card.buttons || [],
      headerImageUrl: displayUrl,
      headerMediaPath: toPermanentUploadPath(rawUrl) || snap.headerMediaPath || card.headerMediaPath || null,
    };
  });

  return {
    ...base,
    isCarousel: true,
    carouselMediaType: base.carouselMediaType || src.carouselMediaType || 'IMAGE',
    header: null,
    headerImageUrl: null,
    headerFormat: null,
    carouselCards,
  };
}

function extractHeaderMediaFromWaComponents(components) {
  const comps = Array.isArray(components) ? components : [];
  const header = comps.find((c) => String(c?.type || '').toLowerCase() === 'header');
  const param = header?.parameters?.[0];
  if (!param) {
    return { header: null, headerImageUrl: null, headerText: null, headerFormat: null };
  }

  const paramType = String(param.type || '').toLowerCase();
  if (paramType === 'image' && param.image?.link) {
    const url = resolveDisplayableHeaderMediaUrl(param.image.link);
    return {
      headerImageUrl: url,
      header: url ? { type: 'image', url } : null,
      headerText: null,
      headerFormat: 'IMAGE',
    };
  }
  if (paramType === 'video' && param.video?.link) {
    const url = resolveDisplayableHeaderMediaUrl(param.video.link);
    return {
      headerImageUrl: url,
      header: url ? { type: 'video', url } : null,
      headerText: null,
      headerFormat: 'VIDEO',
    };
  }
  if (paramType === 'document' && param.document?.link) {
    const url = resolveDisplayableHeaderMediaUrl(param.document.link);
    return {
      headerImageUrl: url,
      header: url ? { type: 'document', url } : null,
      headerText: null,
      headerFormat: 'DOCUMENT',
    };
  }
  if (paramType === 'text' && param.text) {
    const text = String(param.text).trim();
    return {
      header: { type: 'text', text },
      headerText: text,
      headerFormat: 'TEXT',
      headerImageUrl: null,
    };
  }
  return { header: null, headerImageUrl: null, headerText: null, headerFormat: null };
}

/**
 * Merge send-payload header (image.link) into preview before persisting to inboxmessages.
 * Prefer permanent /uploads/... paths so images survive reload on the API host.
 */
function persistCarouselCardMediaOnPreview(preview, carouselCardMediaUrls) {
  if (!preview?.isCarousel || !Array.isArray(preview.carouselCards)) return preview;
  const urls = Array.isArray(carouselCardMediaUrls) ? carouselCardMediaUrls : [];
  const carouselMediaType = String(preview.carouselMediaType || 'IMAGE').toUpperCase();
  return {
    ...preview,
    carouselCards: preview.carouselCards.map((card, idx) => {
      const raw = urls[idx] || card.headerImageUrl || card.headerMediaPath || null;
      if (!raw) return card;
      const permanent = toPermanentUploadPath(raw);
      const displayUrl = permanent ? toPublicMediaUrl(permanent) : toPublicMediaUrl(raw) || raw;
      return {
        ...card,
        headerImageUrl: displayUrl,
        headerMediaPath: permanent || card.headerMediaPath || null,
        headerFormat: carouselMediaType,
      };
    }),
  };
}

function finalizeTemplateSnapshotForInbox(
  preview,
  templatePayloadOrComponents,
  fallbackHeaderUrl,
  extra = {}
) {
  const components = Array.isArray(templatePayloadOrComponents)
    ? templatePayloadOrComponents
    : templatePayloadOrComponents?.template?.components;

  let next = persistCarouselCardMediaOnPreview(
    preview ? { ...preview } : { body: '', footer: '', buttons: [] },
    extra.carouselCardMediaUrls
  );

  const fromSend = extractHeaderMediaFromWaComponents(components);
  const fallbackUrl = resolveDisplayableHeaderMediaUrl(
    fallbackHeaderUrl,
    preview?.headerImageUrl,
    preview?.header?.url
  );

  const skipSingleHeader = Boolean(next.isCarousel);
  if (!skipSingleHeader) {
    const rawHeaderUrl = fromSend.headerImageUrl || fallbackUrl || null;
    const permanent = toPermanentUploadPath(rawHeaderUrl) || toPermanentUploadPath(fallbackHeaderUrl);
    const headerUrl = permanent ? toPublicMediaUrl(permanent) : (toPublicMediaUrl(rawHeaderUrl) || rawHeaderUrl);

    if (headerUrl) {
      next.headerImageUrl = headerUrl;
      next.headerMediaPath = permanent || toPermanentUploadPath(headerUrl) || null;
      const headerType =
        fromSend.header?.type ||
        (fromSend.headerFormat === 'VIDEO'
          ? 'video'
          : fromSend.headerFormat === 'DOCUMENT'
            ? 'document'
            : 'image');
      next.header = { type: headerType, url: headerUrl };
      next.headerFormat = fromSend.headerFormat || next.headerFormat || String(headerType).toUpperCase();
    } else if (fromSend.header) {
      next.header = fromSend.header;
      next.headerText = fromSend.headerText || next.headerText || null;
      next.headerFormat = fromSend.headerFormat || next.headerFormat || null;
    } else if (next.headerImageUrl && !next.header) {
      next.header = { type: 'image', url: next.headerImageUrl };
    } else if (next.header?.url && !next.headerImageUrl) {
      next.headerImageUrl = next.header.url;
    }
  } else {
    next.header = null;
    next.headerImageUrl = null;
    next.headerFormat = null;
    next.headerText = next.headerText || null;
  }

  if (next.isCarousel && Array.isArray(extra.carouselCardMediaUrls)) {
    next = persistCarouselCardMediaOnPreview(next, extra.carouselCardMediaUrls);
  }

  const fromCarouselWa = extractCarouselMediaFromWaComponents(components);
  if (fromCarouselWa) {
    const prevCards = Array.isArray(next.carouselCards) ? next.carouselCards : [];
    const mergedCards = (fromCarouselWa.carouselCards || []).map((card, idx) => {
      const prev = prevCards[idx] || {};
      const url =
        prev.headerImageUrl ||
        prev.headerMediaPath ||
        card.headerImageUrl ||
        card.headerMediaPath ||
        null;
      return {
        ...card,
        ...prev,
        headerImageUrl: url ? normalizeCarouselCardDisplayUrl(url) : card.headerImageUrl,
        headerMediaPath:
          toPermanentUploadPath(url) || prev.headerMediaPath || card.headerMediaPath || null,
      };
    });
    next = {
      ...next,
      ...fromCarouselWa,
      carouselCards: mergedCards.length ? mergedCards : fromCarouselWa.carouselCards,
      body: next.body || fromCarouselWa.body || '',
      header: null,
      headerImageUrl: null,
      headerFormat: null,
    };
    next = hydrateCarouselPreviewMedia(next, next);
  } else if (next.isCarousel) {
    next = hydrateCarouselPreviewMedia(next, next);
  }

  return next;
}

async function resolveHeaderFromCampaign(templateName, projectId) {
  if (!templateName || !projectId) return null;
  const row = await Campaign.findOne({
    where: {
      projectId,
      template_name: templateName,
      header_media_url: { [Op.ne]: null },
    },
    order: [['updatedAt', 'DESC']],
    attributes: ['header_media_url'],
  });
  return row?.header_media_url ? toPublicMediaUrl(row.header_media_url) : null;
}

async function enrichPreviewHeader(preview, { templateName, projectId, templateRecord }) {
  if (!preview) return preview;

  if (preview.isCarousel) {
    return hydrateCarouselPreviewMedia(preview, preview);
  }

  let next = { ...preview };
  if (!next.headerFormat && templateRecord?.variables?.templateType) {
    const t = String(templateRecord.variables.templateType).toLowerCase();
    if (t === 'video') next = { ...next, headerFormat: 'VIDEO' };
    else if (t === 'document') next = { ...next, headerFormat: 'DOCUMENT' };
    else if (t === 'image') next = { ...next, headerFormat: 'IMAGE' };
  }
  if (!next.headerText && templateRecord) {
    const components = getTemplateComponents(templateRecord);
    const header = components.find((c) => String(c.type || '').toUpperCase() === 'HEADER');
    const format = String(header?.format || '').toUpperCase();
    if (format === 'TEXT' && header?.text) {
      next = { ...next, headerFormat: 'TEXT', headerText: String(header.text).trim() };
    } else if (format === 'VIDEO' && !next.headerFormat) {
      next = { ...next, headerFormat: 'VIDEO' };
    } else if (format === 'DOCUMENT' && !next.headerFormat) {
      next = { ...next, headerFormat: 'DOCUMENT' };
    } else if (format === 'IMAGE' && !next.headerFormat) {
      next = { ...next, headerFormat: 'IMAGE' };
    }
  }

  const fromTemplate = resolveDisplayableHeaderMediaUrl(
    templateRecord?.variables?.headerMediaUrl,
    templateRecord?.variables?.header_media_url,
    templateRecord?.headerMediaUrl,
    templateRecord?.header_media_url
  );
  // Prefer permanently stored /uploads image over Meta CDN / ephemeral send links
  if (fromTemplate && toPermanentUploadPath(fromTemplate)) {
    const storedFormat =
      String(next.headerFormat || '').toUpperCase() ||
      (String(templateRecord?.variables?.templateType || '').toLowerCase() === 'video'
        ? 'VIDEO'
        : String(templateRecord?.variables?.templateType || '').toLowerCase() === 'document'
          ? 'DOCUMENT'
          : 'IMAGE');
    const headerType =
      storedFormat === 'VIDEO' ? 'video' : storedFormat === 'DOCUMENT' ? 'document' : 'image';
    return {
      ...next,
      headerImageUrl: fromTemplate,
      headerFormat: storedFormat,
      header: { type: headerType, url: fromTemplate },
    };
  }

  if (next.headerImageUrl || next.header?.url) {
    const permanent = toPermanentUploadPath(next.headerImageUrl || next.header?.url);
    const fixed = permanent
      ? toPublicMediaUrl(permanent)
      : resolveDisplayableHeaderMediaUrl(next.headerImageUrl, next.header?.url);
    if (fixed) {
      const storedFormat = String(next.headerFormat || '').toUpperCase();
      const headerType =
        storedFormat === 'VIDEO' || next.header?.type === 'video'
          ? 'video'
          : storedFormat === 'DOCUMENT' || next.header?.type === 'document'
            ? 'document'
            : 'image';
      return {
        ...next,
        headerImageUrl: fixed,
        header: next.header || { type: headerType, url: fixed },
      };
    }
  }

  if (fromTemplate) {
    const storedFormat =
      String(next.headerFormat || '').toUpperCase() ||
      (String(templateRecord?.variables?.templateType || '').toLowerCase() === 'video'
        ? 'VIDEO'
        : String(templateRecord?.variables?.templateType || '').toLowerCase() === 'document'
          ? 'DOCUMENT'
          : 'IMAGE');
    const headerType =
      storedFormat === 'VIDEO' ? 'video' : storedFormat === 'DOCUMENT' ? 'document' : 'image';
    return {
      ...next,
      headerImageUrl: fromTemplate,
      headerFormat: storedFormat,
      header: next.header || { type: headerType, url: fromTemplate },
    };
  }

  const fromComponents = resolveHeaderImageFromComponents(getTemplateComponents(templateRecord));
  if (fromComponents) {
    return {
      ...next,
      headerImageUrl: fromComponents,
      headerFormat: next.headerFormat || 'IMAGE',
      header: next.header || { type: 'image', url: fromComponents },
    };
  }

  const fromCampaign = await resolveHeaderFromCampaign(templateName, projectId);
  if (fromCampaign) {
    const storedFormat = String(next.headerFormat || '').toUpperCase() || 'IMAGE';
    const headerType =
      storedFormat === 'VIDEO' ? 'video' : storedFormat === 'DOCUMENT' ? 'document' : 'image';
    return {
      ...next,
      headerImageUrl: fromCampaign,
      headerFormat: storedFormat,
      header: next.header || { type: headerType, url: fromCampaign },
    };
  }
  return next;
}

async function buildTemplateCatalogMap(templateRows, { userId, projectId }) {
  const { resolveTemplateComponentsForSend } = require('../services/metaTemplateFetchService');
  const map = new Map();
  await Promise.all(
    (templateRows || []).map(async (row) => {
      const plain = row.get ? row.get({ plain: true }) : row;
      if (!plain?.name) return;
      let components = getTemplateComponents(plain);
      if (!components.length) {
        try {
          components = await resolveTemplateComponentsForSend(plain, {
            userId,
            projectId,
            templateName: plain.name,
          });
        } catch (err) {
          console.warn('buildTemplateCatalogMap Meta fetch:', plain.name, err?.message || err);
        }
      }
      const enriched = {
        ...plain,
        components: components.length ? components : plain.components,
        variables: {
          ...(plain.variables && typeof plain.variables === 'object' ? plain.variables : {}),
          ...(components.length ? { components } : {}),
        },
      };
      map.set(String(plain.name).toLowerCase(), enriched);
    })
  );
  return map;
}

function formatLastMessagePreview(rawMessage, templateSnapshot) {
  const snapshot = parseTemplateSnapshot(templateSnapshot);
  if (snapshot?.body) return String(snapshot.body).trim();

  const msg = String(rawMessage || '').trim();
  if (!msg) return '';
  if (isTemplateMarkerContent(msg)) {
    const name = msg.replace(/^(Template:|\[Template\])\s*/i, '').trim();
    return name ? `Template: ${name}` : 'Template message';
  }
  return msg;
}

module.exports = {
  isTemplateMarkerContent,
  parseTemplateSnapshot,
  applyTemplateParamsToBody,
  buildClientTemplatePreview,
  enrichPreviewHeader,
  formatLastMessagePreview,
  enrichTemplateRecordWithComponents,
  mergeTemplatePreviewWithCatalog,
  buildTemplateCatalogMap,
  extractHeaderMediaFromWaComponents,
  extractCarouselMediaFromWaComponents,
  hydrateCarouselPreviewMedia,
  finalizeTemplateSnapshotForInbox,
  resolveHeaderFromCampaign,
};
