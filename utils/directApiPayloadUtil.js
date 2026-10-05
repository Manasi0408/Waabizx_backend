const { normalizeWhatsAppRecipient } = require('./phoneNormalize');

/**
 * Meta template language codes (create + send). Regional tags like hi_IN are mapped to
 * WhatsApp-supported base codes (e.g. hi) — Meta rejects many *_XX codes on create.
 */
const META_TEMPLATE_LANGUAGE_ALIASES = {
  en: 'en_US',
  en_us: 'en_US',
  en_gb: 'en_GB',
  hi: 'hi',
  hi_in: 'hi',
  mr: 'mr',
  mr_in: 'mr',
  es: 'es',
  es_es: 'es',
  es_mx: 'es',
  fr: 'fr',
  fr_fr: 'fr',
  de: 'de',
  de_de: 'de',
};

function normalizeTemplateLanguageCode(code) {
  const raw = String(code || 'en_US').trim();
  if (!raw) return 'en_US';
  const aliasKey = raw.toLowerCase().replace(/-/g, '_');
  if (META_TEMPLATE_LANGUAGE_ALIASES[aliasKey]) {
    return META_TEMPLATE_LANGUAGE_ALIASES[aliasKey];
  }
  const parts = raw.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) {
    const lang = parts[0].toLowerCase();
    const region = parts.slice(1).join('_').toUpperCase();
    if (lang === 'en') return `${lang}_${region}`;
    const baseKey = lang;
    if (META_TEMPLATE_LANGUAGE_ALIASES[baseKey]) return META_TEMPLATE_LANGUAGE_ALIASES[baseKey];
    return lang;
  }
  if (parts.length === 1) {
    const only = parts[0].toLowerCase();
    return META_TEMPLATE_LANGUAGE_ALIASES[only] || only;
  }
  return raw;
}

function normalizeTemplateComponents(components) {
  if (!Array.isArray(components)) return components;
  return components.map((comp) => {
    const type = String(comp?.type || '').toLowerCase();
    const next = { ...comp, type };
    if (type === 'carousel' && Array.isArray(comp.cards)) {
      next.cards = comp.cards.map((card) => {
        const cardIndex = card?.card_index != null ? card.card_index : card?.cardIndex;
        const inner = normalizeTemplateComponents(card?.components);
        return {
          ...card,
          ...(cardIndex != null ? { card_index: cardIndex } : {}),
          components: inner,
        };
      });
    }
    if (Array.isArray(comp?.parameters)) {
      next.parameters = comp.parameters.map((param) => ({
        ...param,
        type: String(param?.type || 'text').toLowerCase(),
      }));
    }
    if (comp?.sub_type) {
      next.sub_type = String(comp.sub_type).toLowerCase();
    }
    return next;
  });
}

/**
 * Normalize outbound payload for AiSensy Direct API (/messages and /marketing_messages).
 * @see https://backend.aisensy.com/direct-apis docs
 */
function normalizeDirectApiOutboundPayload(payload = {}, options = {}) {
  const isMarketing = options.isMarketing === true;
  const out = { ...(payload || {}) };

  if (!out.messaging_product) {
    out.messaging_product = 'whatsapp';
  }

  if (out.to) {
    out.to = normalizeWhatsAppRecipient(out.to);
  }

  if (out.type === 'text' && !out.recipient_type) {
    out.recipient_type = 'individual';
  }

  if (out.type === 'template' && out.template && typeof out.template === 'object') {
    const tpl = { ...out.template };
    const lang = tpl.language && typeof tpl.language === 'object' ? { ...tpl.language } : {};
    lang.code = normalizeTemplateLanguageCode(lang.code || 'en_US');
    if (!lang.policy) {
      lang.policy = 'deterministic';
    }
    tpl.language = lang;
    if (Array.isArray(tpl.components)) {
      tpl.components = normalizeTemplateComponents(tpl.components);
    }
    if (tpl.name) {
      tpl.name = String(tpl.name).trim();
    }
    out.template = tpl;
  }

  if (isMarketing) {
    if (out.type !== 'template') {
      const err = new Error(
        'marketing_messages supports only Marketing template messages. Use /direct-apis/t1/messages for text/utility templates.'
      );
      err.statusCode = 400;
      throw err;
    }
    if (!out.template?.name) {
      const err = new Error('template.name is required for marketing_messages');
      err.statusCode = 400;
      throw err;
    }
  }

  return out;
}

module.exports = {
  normalizeTemplateLanguageCode,
  normalizeTemplateComponents,
  normalizeDirectApiOutboundPayload,
};
