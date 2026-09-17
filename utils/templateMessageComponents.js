function getTemplateVariablesObject(template) {
  const vars = template?.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) return vars;
  return {};
}

function synthesizeCarouselComponentsFromVars(template) {
  const vars = getTemplateVariablesObject(template);
  const storedCards = Array.isArray(vars.carouselCards) ? vars.carouselCards : [];
  const isCarousel =
    String(vars.templateType || '').toLowerCase() === 'carousel' || storedCards.length > 0;
  if (!isCarousel || !storedCards.length) return null;

  const carouselMediaType = String(vars.carouselMediaType || 'IMAGE').toUpperCase();
  const headerFormat = carouselMediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
  const introBody = String(vars.carouselMainBody || template?.content || '').trim();
  const cards = storedCards.map((card) => ({
    components: [
      { type: 'HEADER', format: headerFormat },
      { type: 'BODY', text: String(card?.body || '').trim() },
      {
        type: 'BUTTONS',
        buttons: (Array.isArray(card?.buttons) ? card.buttons : [])
          .map((btn) => ({
            type: String(btn?.type || 'URL').toUpperCase(),
            text: String(btn?.label || btn?.text || '').trim(),
            url: btn?.url || btn?.value || undefined,
          }))
          .filter((b) => b.text),
      },
    ],
  }));

  const out = [];
  if (introBody) out.push({ type: 'BODY', text: introBody });
  out.push({ type: 'CAROUSEL', cards });
  return out;
}

function getTemplateComponents(template) {
  if (Array.isArray(template?.components) && template.components.length) {
    const fromTop = template.components;
    if (getCarouselCardsFromComponents(fromTop).length) return fromTop;
    const synth = synthesizeCarouselComponentsFromVars(template);
    if (synth?.length) return synth;
    return fromTop;
  }
  const vars = getTemplateVariablesObject(template);
  if (Array.isArray(vars.components) && vars.components.length) {
    if (getCarouselCardsFromComponents(vars.components).length) return vars.components;
    const synth = synthesizeCarouselComponentsFromVars(template);
    if (synth?.length) return synth;
    return vars.components;
  }
  const synth = synthesizeCarouselComponentsFromVars(template);
  return synth?.length ? synth : [];
}

function findComponent(components, type) {
  return (components || []).find((c) => String(c.type || '').toUpperCase() === type);
}

function extractVariableNums(text) {
  const matches = String(text || '').match(/\{\{(\d+)\}\}/g) || [];
  return [...new Set(matches.map((m) => parseInt(m.replace(/[{}]/g, ''), 10)))]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function getTemplateHeaderFormat(template) {
  const components = getTemplateComponents(template);
  const header = findComponent(components, 'HEADER');
  if (header?.format) {
    return String(header.format).toUpperCase();
  }
  return null;
}

function findCardComponent(card, type) {
  const want = String(type || '').toUpperCase();
  return (card?.components || []).find((c) => String(c?.type || '').toUpperCase() === want);
}

function getCarouselCardsFromComponents(components) {
  const carousel = findComponent(components, 'CAROUSEL');
  return Array.isArray(carousel?.cards) ? carousel.cards : [];
}

function extractUrlButtonComponentsFromButtons(buttonsComp, audienceMember = {}) {
  if (!buttonsComp?.buttons?.length) return [];
  const out = [];
  buttonsComp.buttons.forEach((btn, index) => {
    const rawType = String(btn?.type || '').toUpperCase();
    if (rawType !== 'URL') return;
    const url = String(btn?.url || '');
    const varNums = extractVariableNums(url);
    if (!varNums.length) return;
    const parameters = varNums.map((n) => {
      const val = audienceMember[`var${n}`];
      return {
        type: 'text',
        text: val == null || String(val).trim() === '' ? 'NA' : String(val),
      };
    });
    out.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters,
    });
  });
  return out;
}

function parseTemplateSendSpec(components, fallbackContent = '', options = {}) {
  const comps = Array.isArray(components) ? components : [];
  const header = findComponent(comps, 'HEADER');
  const body = findComponent(comps, 'BODY');
  const bodyText = body?.text || fallbackContent || '';
  const bodyVarNums = extractVariableNums(bodyText);

  const carouselCards = getCarouselCardsFromComponents(comps);
  const typeCarousel = String(options.templateType || '').toLowerCase() === 'carousel';
  const optionCarouselCards = Array.isArray(options.carouselCards) ? options.carouselCards : [];
  const isCarousel =
    carouselCards.length > 0 || typeCarousel || optionCarouselCards.length > 0;

  if (isCarousel) {
    let carouselCardHeaderFormat = String(options.carouselMediaType || 'IMAGE').toUpperCase();
    if (carouselCards[0]) {
      const cardHeader = findCardComponent(carouselCards[0], 'HEADER');
      if (cardHeader?.format) {
        carouselCardHeaderFormat = String(cardHeader.format).toUpperCase();
      }
    }
    if (!['IMAGE', 'VIDEO'].includes(carouselCardHeaderFormat)) {
      carouselCardHeaderFormat = 'IMAGE';
    }
    const carouselCardCount =
      carouselCards.length || optionCarouselCards.length;

    return {
      isCarousel: true,
      carouselCardCount,
      carouselCardHeaderFormat,
      headerFormat: null,
      headerVarNums: [],
      bodyVarNums,
      needsHeaderMedia: false,
      needsCarouselMedia: carouselCardCount > 0,
      needsHeaderText: false,
    };
  }

  let headerFormat = header?.format ? String(header.format).toUpperCase() : null;
  if (!headerFormat && options.templateType) {
    const typeMap = { image: 'IMAGE', video: 'VIDEO', document: 'DOCUMENT' };
    headerFormat = typeMap[String(options.templateType).toLowerCase()] || null;
  }
  const headerVarNums = headerFormat === 'TEXT' ? extractVariableNums(header?.text) : [];

  return {
    isCarousel: false,
    headerFormat,
    headerVarNums,
    bodyVarNums,
    needsHeaderMedia: ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat || ''),
    needsHeaderText: headerFormat === 'TEXT' && headerVarNums.length > 0,
    needsCarouselMedia: false,
    carouselCardCount: 0,
    carouselCardHeaderFormat: null,
  };
}

function templateRequiresHeaderMedia(template) {
  const format = getTemplateHeaderFormat(template);
  return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format || '');
}

function getUploadsPublicBase() {
  const raw = String(
    process.env.UPLOADS_PUBLIC_BASE ||
      process.env.API_PUBLIC_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.PUBLIC_API_URL ||
      process.env.APP_URL ||
      'https://api.waabizx.com'
  )
    .trim()
    .replace(/\/$/, '')
    .replace(/\/api$/i, '');
  // Frontend app host does not serve /uploads — Express API does.
  if (/^https?:\/\/app\.waabizx\.com$/i.test(raw)) {
    return 'https://api.waabizx.com';
  }
  return raw || 'https://api.waabizx.com';
}

/** Normalize any upload URL back to a permanent relative path `/uploads/...`. */
function toPermanentUploadPath(url) {
  const value = String(url || '').trim();
  if (!value || value.startsWith('blob:')) return null;
  // Accept both /uploads/... and /api/uploads/... (proxy-safe public path)
  const match = value.match(/\/(?:api\/)?uploads\/[^\s?#]+/i);
  if (match) {
    let p = match[0].split('?')[0];
    if (/^\/api\/uploads\//i.test(p)) {
      p = p.replace(/^\/api\/uploads\//i, '/uploads/');
    }
    return p;
  }
  if (value.startsWith('uploads/')) return `/${value.split('?')[0]}`;
  if (value.startsWith('api/uploads/')) {
    return `/${value.split('?')[0]}`.replace(/^\/api\/uploads\//i, '/uploads/');
  }
  return null;
}

/**
 * Public browser URL for an upload.
 * Production reverse proxies usually expose only `/api/*` to Node, so we publish
 * files under `/api/uploads/...` (same folder as `/uploads` on disk).
 */
function toPublicUploadPath(url) {
  const permanent = toPermanentUploadPath(url);
  if (!permanent) return null;
  return permanent.replace(/^\/uploads\//i, '/api/uploads/');
}

function toPublicMediaUrl(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value || value.startsWith('blob:')) return null;

  const publicPath = toPublicUploadPath(value);
  if (publicPath) {
    return `${getUploadsPublicBase()}${publicPath}`;
  }

  if (/^https?:\/\//i.test(value)) return value;

  const base = getUploadsPublicBase();
  return `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

/** Meta upload handles (e.g. "4::aW1hZ2U...") are not browser-displayable URLs. */
function isMetaMediaHandle(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (/^\d+::/.test(value)) return true;
  if (toPermanentUploadPath(value)) return false;
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/uploads/') && !value.startsWith('/api/uploads/')) {
    return true;
  }
  return false;
}

function resolveDisplayableHeaderMediaUrl(...candidates) {
  for (const candidate of candidates) {
    const publicUrl = toPublicMediaUrl(candidate);
    if (publicUrl && !isMetaMediaHandle(publicUrl)) {
      return publicUrl;
    }
  }
  return null;
}

/** Meta template HEADER example URLs (when no campaign/upload URL is stored). */
function resolveHeaderImageFromComponents(components) {
  const header = (components || []).find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  const format = String(header?.format || '').toUpperCase();
  if (format !== 'IMAGE') return null;
  const handles = header?.example?.header_handle;
  if (Array.isArray(handles) && handles[0] && /^https?:\/\//i.test(String(handles[0]))) {
    return String(handles[0]).trim();
  }
  return null;
}

function buildBodyParamsFromAudience(bodyVarNums, audienceMember) {
  return bodyVarNums.map((n) => {
    const val = audienceMember[`var${n}`];
    return val == null || String(val).trim() === '' ? 'NA' : String(val);
  });
}

function buildHeaderTextParamsFromAudience(headerVarNums, audienceMember) {
  return headerVarNums.map((n) => {
    const val = audienceMember[`var${n}`];
    return val == null || String(val).trim() === '' ? 'NA' : String(val);
  });
}

function extractDynamicUrlButtonComponents(components, audienceMember = {}) {
  const buttonsComp = findComponent(components, 'BUTTONS');
  if (!buttonsComp?.buttons?.length) return [];

  const out = [];
  buttonsComp.buttons.forEach((btn, index) => {
    const rawType = String(btn?.type || '').toUpperCase();
    if (rawType !== 'URL') return;

    const url = String(btn?.url || '');
    const varNums = extractVariableNums(url);
    if (!varNums.length) return;

    const parameters = varNums.map((n) => {
      const val = audienceMember[`var${n}`];
      return {
        type: 'text',
        text: val == null || String(val).trim() === '' ? 'NA' : String(val),
      };
    });

    out.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters,
    });
  });

  return out;
}

/**
 * Build WhatsApp template components that exactly match Meta-approved template structure.
 * Never guess IMAGE header from upload alone — only when sendSpec says so.
 */
function buildWhatsAppTemplateComponents({ sendSpec, headerMediaUrl, headerMediaId, audienceMember }) {
  if (!sendSpec) return undefined;

  const components = [];
  const format = String(sendSpec.headerFormat || '').toUpperCase();
  const publicUrl = toPublicMediaUrl(headerMediaUrl);

  if (format === 'IMAGE') {
    if (headerMediaId) {
      components.push({
        type: 'header',
        parameters: [{ type: 'image', image: { id: String(headerMediaId) } }],
      });
    } else if (publicUrl) {
      components.push({
        type: 'header',
        parameters: [{ type: 'image', image: { link: publicUrl } }],
      });
    } else {
      throw new Error('Header image URL is required for this template');
    }
  } else if (format === 'VIDEO') {
    if (headerMediaId) {
      components.push({
        type: 'header',
        parameters: [{ type: 'video', video: { id: String(headerMediaId) } }],
      });
    } else if (publicUrl) {
      components.push({
        type: 'header',
        parameters: [{ type: 'video', video: { link: publicUrl } }],
      });
    } else {
      throw new Error('Header video URL is required for this template');
    }
  } else if (format === 'DOCUMENT') {
    if (headerMediaId) {
      const filename = publicUrl ? publicUrl.split('/').pop() || 'document.pdf' : 'document.pdf';
      components.push({
        type: 'header',
        parameters: [{ type: 'document', document: { id: String(headerMediaId), filename } }],
      });
    } else if (publicUrl) {
      const filename = publicUrl.split('/').pop() || 'document.pdf';
      components.push({
        type: 'header',
        parameters: [{ type: 'document', document: { link: publicUrl, filename } }],
      });
    } else {
      throw new Error('Header document URL is required for this template');
    }
  } else if (format === 'TEXT' && sendSpec.headerVarNums?.length > 0) {
    const headerParams = buildHeaderTextParamsFromAudience(sendSpec.headerVarNums, audienceMember || {});
    components.push({
      type: 'header',
      parameters: headerParams.map((text) => ({ type: 'text', text })),
    });
  }

  if (sendSpec.bodyVarNums?.length > 0) {
    const bodyParams = buildBodyParamsFromAudience(sendSpec.bodyVarNums, audienceMember || {});
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text })),
    });
  }

  return components.length > 0 ? components : undefined;
}

/**
 * Build WhatsApp carousel template send components (intro body + per-card header media).
 */
function buildWhatsAppCarouselTemplateComponents({
  sendSpec,
  resolvedComponents,
  cardHeaderMediaIds,
  cardHeaderMediaUrls,
  audienceMember,
}) {
  if (!sendSpec?.isCarousel) return undefined;

  const cardDefs = getCarouselCardsFromComponents(resolvedComponents);
  const count = cardDefs.length || sendSpec.carouselCardCount || 0;
  if (!count) {
    throw new Error('Carousel template has no cards');
  }

  const ids = Array.isArray(cardHeaderMediaIds) ? cardHeaderMediaIds : [];
  const rawUrls = Array.isArray(cardHeaderMediaUrls) ? cardHeaderMediaUrls : [];
  if (rawUrls.length !== count && ids.length !== count) {
    throw new Error(`Carousel template requires header media for all ${count} cards`);
  }

  const format = String(sendSpec.carouselCardHeaderFormat || 'IMAGE').toUpperCase();
  const out = [];

  if (sendSpec.bodyVarNums?.length > 0) {
    const bodyParams = buildBodyParamsFromAudience(sendSpec.bodyVarNums, audienceMember || {});
    out.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text })),
    });
  }

  const cards = cardDefs.map((cardDef, cardIndex) => {
    const mediaId = ids[cardIndex] || null;
    const publicUrl = toPublicMediaUrl(
      toPermanentUploadPath(rawUrls[cardIndex]) || rawUrls[cardIndex]
    );
    if (!mediaId && !publicUrl) {
      throw new Error(`Card ${cardIndex + 1} header media is required`);
    }

    const cardComponents = [];
    if (format === 'VIDEO') {
      if (!mediaId) {
        throw new Error(
          `Card ${cardIndex + 1} video must be uploaded to WhatsApp before send (use MP4 from Media Library)`
        );
      }
      cardComponents.push({
        type: 'header',
        parameters: [{ type: 'video', video: { id: String(mediaId) } }],
      });
    } else if (mediaId) {
      cardComponents.push({
        type: 'header',
        parameters: [{ type: 'image', image: { id: String(mediaId) } }],
      });
    } else if (publicUrl) {
      cardComponents.push({
        type: 'header',
        parameters: [{ type: 'image', image: { link: publicUrl } }],
      });
    } else {
      throw new Error(
        `Card ${cardIndex + 1} image must be uploaded to WhatsApp before send (choose from Media Library)`
      );
    }

    const cardBody = findCardComponent(cardDef, 'BODY');
    const cardBodyVarNums = extractVariableNums(cardBody?.text);
    if (cardBodyVarNums.length > 0) {
      const cardBodyParams = buildBodyParamsFromAudience(cardBodyVarNums, audienceMember || {});
      cardComponents.push({
        type: 'body',
        parameters: cardBodyParams.map((text) => ({ type: 'text', text })),
      });
    }

    const buttonsComp = findCardComponent(cardDef, 'BUTTONS');
    cardComponents.push(...extractUrlButtonComponentsFromButtons(buttonsComp, audienceMember));

    return { card_index: cardIndex, components: cardComponents };
  });

  out.push({ type: 'carousel', cards });
  return out.length > 0 ? out : undefined;
}

function extractButtonsFromComponents(components) {
  const buttons = [];
  (components || []).forEach((comp) => {
    const type = String(comp?.type || '').toUpperCase();
    if (type === 'BUTTONS' && Array.isArray(comp.buttons)) {
      buttons.push(...comp.buttons);
    }
  });
  return buttons.map((btn) => {
    const rawType = String(btn?.type || 'QUICK_REPLY').toUpperCase();
    return {
      type: rawType === 'PHONE' ? 'PHONE_NUMBER' : rawType,
      text: btn?.text || btn?.title || '',
      url: btn?.url,
      phone_number: btn?.phone_number || btn?.phoneNumber,
    };
  }).filter((b) => String(b.text || '').trim());
}

function normalizeFlowButtons(buttons) {
  return (buttons || [])
    .map((b) => {
      if (typeof b === 'string') return { type: 'QUICK_REPLY', text: b };
      const rawType = String(b?.type || 'QUICK_REPLY').toUpperCase();
      return {
        type: rawType === 'PHONE' ? 'PHONE_NUMBER' : rawType,
        text: b?.text || b?.title || b?.label || '',
        url: b?.url,
        phone_number: b?.phone_number || b?.phoneNumber,
      };
    })
    .filter((b) => String(b.text || '').trim());
}

function metaTemplateHasButtons(components) {
  return extractButtonsFromComponents(components).length > 0;
}

/** Use broadcast/campaign stored header hint when DB template metadata is incomplete. */
function applyCampaignHeaderHint(sendSpec, campaign) {
  const spec = sendSpec || {
    headerFormat: null,
    headerVarNums: [],
    bodyVarNums: [],
    needsHeaderMedia: false,
    needsHeaderText: false,
  };
  if (spec.headerFormat) return spec;

  const hint = String(campaign?.template_header_format || '').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hint)) return spec;

  return {
    ...spec,
    headerFormat: hint,
    needsHeaderMedia: true,
  };
}

module.exports = {
  getTemplateComponents,
  getTemplateHeaderFormat,
  parseTemplateSendSpec,
  templateRequiresHeaderMedia,
  toPublicMediaUrl,
  toPublicUploadPath,
  toPermanentUploadPath,
  getUploadsPublicBase,
  isMetaMediaHandle,
  resolveDisplayableHeaderMediaUrl,
  resolveHeaderImageFromComponents,
  buildWhatsAppTemplateComponents,
  buildWhatsAppCarouselTemplateComponents,
  getCarouselCardsFromComponents,
  buildBodyParamsFromAudience,
  extractButtonsFromComponents,
  extractDynamicUrlButtonComponents,
  normalizeFlowButtons,
  metaTemplateHasButtons,
  applyCampaignHeaderHint,
};
