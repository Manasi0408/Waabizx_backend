const axios = require('axios');
const { Template } = require('../models');
const {
  getTemplateComponents,
  getCarouselCardsFromComponents,
} = require('../utils/templateMessageComponents');

const getMetaApiVersion = () => process.env.WHATSAPP_API_VERSION || 'v22.0';
const META_TEMPLATE_LIST_CACHE_MS = 5 * 60 * 1000;
const metaTemplateListCache = new Map();

const normalizeMetaTemplateName = (name) =>  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

async function resolveMetaCredentialsForProject(userId, projectId) {
  const { WhatsAppAccount } = require('../models');
  const envWaba = String(process.env.WABA_ID || process.env.WABAID || '').trim();
  const envToken =
    process.env.WHATSAPP_TOKEN ||
    process.env.PERMANENT_TOKEN ||
    process.env.WA_ACCESS_TOKEN ||
    process.env.Whatsapp_Token;

  if (projectId) {
    const scoped = await WhatsAppAccount.findOne({
      where: { client_id: Number(userId), projectId: Number(projectId) },
      attributes: ['waba_id', 'access_token'],
      order: [['id', 'DESC']],
    });
    if (scoped) {
      const wabaId = String(scoped.waba_id || '').trim();
      const token = String(scoped.access_token || '').trim();
      if (wabaId && token) return { wabaId, token };
    }
  }

  const latest = await WhatsAppAccount.findOne({
    where: { client_id: Number(userId) },
    attributes: ['waba_id', 'access_token'],
    order: [['id', 'DESC']],
  });
  if (latest) {
    const wabaId = String(latest.waba_id || '').trim();
    const token = String(latest.access_token || '').trim();
    if (wabaId && token) return { wabaId, token };
  }

  return { wabaId: envWaba, token: envToken };
}

async function fetchAllMetaMessageTemplates(wabaId, token, apiVersion) {
  const cacheKey = String(wabaId || '');
  const cached = metaTemplateListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < META_TEMPLATE_LIST_CACHE_MS) {
    return cached.templates;
  }

  const all = [];
  let nextUrl = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  let useParams = { limit: 100 };
  let guard = 0;

  try {
    while (nextUrl && guard < 25) {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
        ...(useParams ? { params: useParams } : {}),
      });
      all.push(...(response.data?.data || []));
      nextUrl = response.data?.paging?.next || null;
      useParams = null;
      guard += 1;
    }
  } catch (err) {
    console.warn('Meta template list fetch failed:', err?.message || err);
    if (cached?.templates?.length) return cached.templates;
    return [];
  }

  if (cacheKey) {
    metaTemplateListCache.set(cacheKey, { at: Date.now(), templates: all });
  }

  return all;
}
async function fetchMetaTemplateComponentsById(metaTemplateId, token, apiVersion) {
  if (!metaTemplateId || !token) return [];
  try {
    const response = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(metaTemplateId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          fields: 'id,name,status,language,components',
        },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
    if (response.status >= 400) return [];
    return Array.isArray(response.data?.components) ? response.data.components : [];
  } catch (_) {
    return [];
  }
}

const META_TEMPLATE_SAFE_FIELDS =
  'id,name,status,category,language,components';

async function fetchMetaTemplateRecordById(metaTemplateId, token, apiVersion) {
  if (!metaTemplateId || !token) return null;
  try {
    const response = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(metaTemplateId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: META_TEMPLATE_SAFE_FIELDS },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
    if (response.status >= 400 || !response.data?.id) {
      return { error: response.data, status: response.status };
    }
    return { template: response.data, status: response.status };
  } catch (err) {
    return {
      error: err?.response?.data || { message: err?.message || 'Meta request failed' },
      status: err?.response?.status || 500,
    };
  }
}

function mapLocalTemplateToMetaShape(local, metaTemplateId) {
  const components = getTemplateComponents(local);
  const statusMap = {
    approved: 'APPROVED',
    rejected: 'REJECTED',
    draft: 'PENDING',
  };
  const categoryMap = {
    marketing: 'MARKETING',
    utility: 'UTILITY',
    notification: 'AUTHENTICATION',
  };
  const vars = local?.variables;
  const language =
    vars && typeof vars === 'object' && !Array.isArray(vars) && vars.language
      ? String(vars.language)
      : 'en_US';

  return {
    id: String(metaTemplateId),
    name: local.name,
    status: statusMap[String(local.status || '').toLowerCase()] || 'PENDING',
    category: categoryMap[String(local.category || '').toLowerCase()] || 'MARKETING',
    language,
    components,
    source: 'local_db',
  };
}

/**
 * Resolve a Meta template by ID with fallbacks:
 * 1) Graph API by template id (safe fields only)
 * 2) WABA message_templates list match by id
 * 3) Local templates table (metaTemplateId)
 */
async function fetchMetaTemplateById(metaTemplateId, userId, projectId) {
  const id = String(metaTemplateId || '').trim();
  if (!id) return { template: null, source: null, error: { message: 'Template ID is required' }, status: 400 };

  const { wabaId, token } = await resolveMetaCredentialsForProject(userId, projectId);
  if (!token) {
    return {
      template: null,
      source: null,
      error: { message: 'WhatsApp access token not configured for this project' },
      status: 400,
    };
  }

  const apiVersion = getMetaApiVersion();
  const direct = await fetchMetaTemplateRecordById(id, token, apiVersion);
  if (direct?.template) {
    return { template: direct.template, source: 'meta_direct', error: null, status: 200 };
  }

  if (wabaId) {
    const templates = await fetchAllMetaMessageTemplates(wabaId, token, apiVersion);
    const fromList = templates.find((t) => String(t.id) === id);
    if (fromList) {
      return { template: fromList, source: 'meta_list', error: null, status: 200 };
    }
  }

  if (userId) {
    const where = {
      userId: Number(userId),
      metaTemplateId: id,
      ...(projectId ? { projectId: Number(projectId) } : {}),
    };
    const local = await Template.findOne({
      where,
      attributes: ['id', 'name', 'content', 'status', 'category', 'variables', 'metaTemplateId'],
      order: [['id', 'DESC']],
    });
    if (local) {
      const shaped = mapLocalTemplateToMetaShape(local, id);
      if (shaped.components?.length) {
        return { template: shaped, source: 'local_db', error: null, status: 200 };
      }
    }
  }

  return {
    template: null,
    source: null,
    error: direct?.error || { message: 'Template not found in Meta or local database' },
    status: direct?.status && direct.status !== 200 ? direct.status : 404,
  };
}

async function fetchMetaTemplateComponentsByName(templateName, userId, projectId) {
  const { wabaId, token } = await resolveMetaCredentialsForProject(userId, projectId);
  if (!wabaId || !token) return [];

  const apiVersion = getMetaApiVersion();
  const normalized = normalizeMetaTemplateName(templateName);
  const templates = await fetchAllMetaMessageTemplates(wabaId, token, apiVersion);
  const match = templates.find((t) => normalizeMetaTemplateName(t.name) === normalized);
  return Array.isArray(match?.components) ? match.components : [];
}

function templateExpectsCarousel(template) {
  const vars =
    template?.variables && typeof template.variables === 'object' && !Array.isArray(template.variables)
      ? template.variables
      : {};
  return (
    String(vars.templateType || '').toLowerCase() === 'carousel' ||
    (Array.isArray(vars.carouselCards) && vars.carouselCards.length > 0)
  );
}

async function resolveTemplateComponentsForSend(template, { userId, projectId, templateName }) {
  const fromLocal = getTemplateComponents(template);
  const expectsCarousel = templateExpectsCarousel(template);
  const hasCarouselBlock = getCarouselCardsFromComponents(fromLocal).length > 0;
  if (fromLocal.length && (!expectsCarousel || hasCarouselBlock)) {
    return fromLocal;
  }

  const metaTemplateId = template?.metaTemplateId;
  if (metaTemplateId) {
    const { token } = await resolveMetaCredentialsForProject(userId, projectId);
    const fromId = await fetchMetaTemplateComponentsById(
      metaTemplateId,
      token,
      getMetaApiVersion()
    );
    if (fromId.length) return fromId;
  }

  const name = template?.name || templateName;
  if (name) {
    const fromName = await fetchMetaTemplateComponentsByName(name, userId, projectId);
    if (fromName.length) return fromName;
  }

  return getTemplateComponents(template);
}

async function loadTemplateRecordForCampaign({ userId, projectId, templateName }) {
  const normalized = normalizeMetaTemplateName(templateName);
  let template = await Template.findOne({
    where: { userId, projectId, name: templateName },
    attributes: ['id', 'name', 'content', 'status', 'category', 'variables', 'metaTemplateId'],
  });
  if (!template && normalized) {
    template = await Template.findOne({
      where: { userId, projectId, name: normalized },
      attributes: ['id', 'name', 'content', 'status', 'category', 'variables', 'metaTemplateId'],
    });
  }
  return template;
}

async function fetchMetaTemplateByName(templateName, userId, projectId) {
  const { wabaId, token } = await resolveMetaCredentialsForProject(userId, projectId);
  if (!wabaId || !token) return null;

  const apiVersion = getMetaApiVersion();
  const normalized = normalizeMetaTemplateName(templateName);
  const templates = await fetchAllMetaMessageTemplates(wabaId, token, apiVersion);
  return (
    templates.find((t) => normalizeMetaTemplateName(t.name) === normalized) || null
  );
}

/**
 * Campaign/broadcast path — avoid Meta template list API (shared with flows; can rate-limit).
 * Uses local DB template + optional single-template fetch by metaTemplateId only.
 */
async function resolveTemplateForCampaign({
  template,
  campaign,
  userId,
  projectId,
}) {
  let components = getTemplateComponents(template);
  const language =
    String(campaign?.template_language || '').trim() ||
    String(template?.variables?.language || '').trim() ||
    'en_US';

  if (!components.length && template?.metaTemplateId) {
    try {
      const { token } = await resolveMetaCredentialsForProject(userId, projectId);
      if (token) {
        components = await fetchMetaTemplateComponentsById(
          template.metaTemplateId,
          token,
          getMetaApiVersion()
        );
      }
    } catch (err) {
      console.warn('Campaign template components by id failed:', err?.message || err);
    }
  }

  return {
    components: components || [],
    language,
    metaTemplate: null,
  };
}

/**
 * Flow path — may call Meta template list for button/header structure and follow-ups.
 */
async function resolveTemplateForFlow({ template, userId, projectId, templateName }) {
  const name = template?.name || templateName;
  let components = getTemplateComponents(template);

  let language = 'en_US';
  const vars = template?.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars) && vars.language) {
    language = String(vars.language);
  }

  let metaTpl = null;

  if (!components.length && template?.metaTemplateId) {
    const { token } = await resolveMetaCredentialsForProject(userId, projectId);
    components = await fetchMetaTemplateComponentsById(
      template.metaTemplateId,
      token,
      getMetaApiVersion()
    );
  }

  if (name) {
    metaTpl = await fetchMetaTemplateByName(name, userId, projectId);
    if (metaTpl?.language) {
      language = String(metaTpl.language);
    }
    if (!components.length && Array.isArray(metaTpl?.components) && metaTpl.components.length) {
      components = metaTpl.components;
    }
  }

  return {
    components: components || [],
    language,
    metaTemplate: metaTpl,
  };
}

/** @deprecated use resolveTemplateForFlow or resolveTemplateForCampaign */
const resolveTemplateForSend = resolveTemplateForFlow;

module.exports = {
  normalizeMetaTemplateName,
  resolveTemplateComponentsForSend,
  resolveTemplateForCampaign,
  resolveTemplateForFlow,
  resolveTemplateForSend,
  fetchMetaTemplateByName,
  fetchMetaTemplateById,
  loadTemplateRecordForCampaign,
  fetchMetaTemplateComponentsByName,
  fetchAllMetaMessageTemplates,
  resolveMetaCredentialsForProject,
};
