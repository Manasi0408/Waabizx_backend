const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Template, WhatsAppAccount, ProjectApiToken } = require('../models');
const Campaign = require('../models/Campaign');
const { Op } = require('sequelize');
const { requireProjectId, getProjectId } = require('../utils/projectScope');
const { enforcePlanLimit } = require('../services/planLimitService');
const {
  enrichComponentsWithHeaderExamples,
  formatAxiosMetaError,
  withMetaRateLimitRetry,
} = require('../services/metaTemplateMediaService');
const { saveTemplateHeaderMediaToUploads, copyTemplateHeaderMedia, loadHeaderMediaFromUpload } = require('../services/templateHeaderMediaStorage');
const { toPermanentUploadPath, toPublicMediaUrl } = require('../utils/templateMessageComponents');
const { logApiFailure } = require('../utils/logger');
const {
  fetchMetaTemplateById,
  fetchMetaTemplateComponentsByName,
} = require('../services/metaTemplateFetchService');
const { normalizeTemplateLanguageCode } = require('../utils/directApiPayloadUtil');
const Project = require('../models/Project');
const sequelize = require('../config/database');

async function ensureDeletedTemplatesTable() {
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS deleted_project_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        projectId INT NOT NULL,
        templateName VARCHAR(255) NOT NULL,
        metaTemplateId VARCHAR(64) NULL,
        deletedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_project_template_name (projectId, templateName)
      )
    `);
  } catch (error) {
    console.error('ensureDeletedTemplatesTable error:', error.message || error);
  }
}

async function recordDeletedTemplate(projectId, templateName, metaTemplateId) {
  try {
    await ensureDeletedTemplatesTable();
    const name = String(templateName || '').trim().toLowerCase();
    if (!name) return;

    await sequelize.query(
      `INSERT INTO deleted_project_templates (projectId, templateName, metaTemplateId)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         metaTemplateId = COALESCE(VALUES(metaTemplateId), metaTemplateId),
         deletedAt = CURRENT_TIMESTAMP`,
      {
        replacements: [Number(projectId), name, metaTemplateId ? String(metaTemplateId) : null],
      }
    );
  } catch (error) {
    console.error('recordDeletedTemplate error:', error.message || error);
  }
}

async function getDeletedTemplateLookup(projectId) {
  try {
    await ensureDeletedTemplatesTable();
    const [rows] = await sequelize.query(
      'SELECT templateName, metaTemplateId FROM deleted_project_templates WHERE projectId = ?',
      { replacements: [Number(projectId)] }
    );

    const names = new Set();
    const metaIds = new Set();
    for (const row of rows || []) {
      if (row.templateName) names.add(String(row.templateName).trim().toLowerCase());
      if (row.metaTemplateId) metaIds.add(String(row.metaTemplateId).trim());
    }
    return { names, metaIds };
  } catch (error) {
    console.error('getDeletedTemplateLookup error:', error.message || error);
    return { names: new Set(), metaIds: new Set() };
  }
}

function isTemplateDeletedInLookup(lookup, templateName, metaTemplateId) {
  const name = String(templateName || '').trim().toLowerCase();
  if (name && lookup.names.has(name)) return true;
  const metaId = metaTemplateId ? String(metaTemplateId).trim() : '';
  if (metaId && lookup.metaIds.has(metaId)) return true;
  return false;
}

function isTemplateRowDeleted(row) {
  if (!row) return false;
  const plain = row.get ? row.get({ plain: true }) : row;
  if (plain.deletedAt) return true;
  const vars = plain.variables;
  if (vars && typeof vars === 'object' && !Array.isArray(vars) && vars.deleted === true) return true;
  return false;
}

function isTemplateVisible(row, deletedLookup) {
  if (!row) return false;
  const plain = row.get ? row.get({ plain: true }) : row;
  if (isTemplateRowDeleted(plain)) return false;
  return !isTemplateDeletedInLookup(deletedLookup, plain.name, plain.metaTemplateId);
}

async function markTemplatesDeleted(scope, { id, name, metaTemplateId }) {
  const projectId = Number(scope.projectId);
  const targetName = String(name || '').trim().toLowerCase();
  const targetId = Number(id);
  const targetMetaId = metaTemplateId ? String(metaTemplateId).trim() : '';

  const rows = await Template.findAll({
    where: { projectId },
  });

  const now = new Date();
  const matches = rows.filter((row) => {
    const plain = row.get ? row.get({ plain: true }) : row;
    if (Number.isInteger(targetId) && targetId > 0 && Number(plain.id) === targetId) return true;
    if (targetName && String(plain.name || '').trim().toLowerCase() === targetName) return true;
    if (targetMetaId && String(plain.metaTemplateId || '').trim() === targetMetaId) return true;
    return false;
  });

  for (const row of matches) {
    const vars =
      row.variables && typeof row.variables === 'object' && !Array.isArray(row.variables)
        ? { ...row.variables }
        : {};
    vars.deleted = true;
    vars.deletedAt = now.toISOString();
    try {
      await row.update({ deletedAt: now, variables: vars });
    } catch (error) {
      if (/deletedAt|Unknown column/i.test(String(error.message || ''))) {
        await row.update({ variables: vars });
      } else {
        throw error;
      }
    }
  }

  await recordDeletedTemplate(projectId, name, metaTemplateId);
  return matches.length;
}

function buildActiveTemplateWhere(scope, extra = {}) {
  return {
    ...buildTemplateWhere(scope, extra),
    deletedAt: { [Op.is]: null },
  };
}

async function findTemplatesForList(where, options = {}) {
  try {
    return await Template.findAll({ where, ...options });
  } catch (error) {
    if (!/deletedAt|Unknown column/i.test(String(error.message || ''))) throw error;
    const fallbackWhere = { ...where };
    delete fallbackWhere.deletedAt;
    const rows = await Template.findAll({ where: fallbackWhere, ...options });
    const deletedLookup = await getDeletedTemplateLookup(
      Number(where.projectId || options.projectId || 0)
    );
    return rows.filter((row) => isTemplateVisible(row, deletedLookup));
  }
}

async function resolveTemplateScope(req, res) {
  const projectId = requireProjectId(req, res);
  if (!projectId) return null;

  const userId = Number(req.user?.id);
  const ownerId = await Project.getProjectOwnerId(projectId);
  const userIds = [
    ...new Set([userId, Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0)),
  ];

  return {
    projectId: Number(projectId),
    userId,
    ownerId: Number(ownerId) || userId,
    userIds,
  };
}

function buildTemplateWhere(scope, extra = {}) {
  return {
    projectId: scope.projectId,
    userId: { [Op.in]: scope.userIds },
    ...extra,
  };
}

async function enrichTemplatesWithBroadcastHeader(templates, projectId) {
  if (!projectId || !Array.isArray(templates) || !templates.length) return templates;

  const names = [
    ...new Set(
      templates
        .map((row) => {
          const plain = row?.get ? row.get({ plain: true }) : row;
          return String(plain?.name || '').trim();
        })
        .filter(Boolean)
    ),
  ];
  if (!names.length) return templates;

  const campaigns = await Campaign.findAll({
    where: {
      projectId: Number(projectId),
      template_name: { [Op.in]: names },
      header_media_url: { [Op.ne]: null },
    },
    attributes: ['template_name', 'header_media_url', 'updatedAt'],
    order: [['updatedAt', 'DESC']],
  });

  const headerByTemplate = new Map();
  for (const row of campaigns) {
    const key = String(row.template_name || '').toLowerCase();
    if (!headerByTemplate.has(key)) {
      headerByTemplate.set(key, toPublicMediaUrl(row.header_media_url));
    }
  }

  return templates.map((row) => {
    const plain = row?.get ? row.get({ plain: true }) : { ...row };
    const key = String(plain.name || '').toLowerCase();
    const broadcastHeader = headerByTemplate.get(key);

    const vars =
      plain.variables && typeof plain.variables === 'object' && !Array.isArray(plain.variables)
        ? { ...plain.variables }
        : {};

    if (!vars.headerMediaUrl && !vars.header_media_url && broadcastHeader) {
      vars.headerMediaUrl = broadcastHeader;
      if (!vars.templateType) vars.templateType = 'image';
    }

    // Always expose a fetchable public URL for UI + send (/api/uploads/... on API host)
    const permanent =
      toPermanentUploadPath(vars.headerMediaUrl || vars.header_media_url || plain.headerMediaUrl) ||
      null;
    if (permanent) {
      const publicUrl = toPublicMediaUrl(permanent);
      vars.headerMediaUrl = publicUrl;
      vars.header_media_url = publicUrl;
      plain.headerMediaUrl = publicUrl;
      plain.header_media_url = publicUrl;
    } else if (vars.headerMediaUrl || vars.header_media_url) {
      const publicUrl = toPublicMediaUrl(vars.headerMediaUrl || vars.header_media_url);
      if (publicUrl) {
        vars.headerMediaUrl = publicUrl;
        vars.header_media_url = publicUrl;
        plain.headerMediaUrl = publicUrl;
        plain.header_media_url = publicUrl;
      }
    }

    return { ...plain, variables: vars };
  });
}

const templateHeaderUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, '../uploads/templates');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `template-header-${uniqueSuffix}${path.extname(file.originalname || '.jpg')}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

exports.uploadTemplateHeaderPreviewMiddleware = templateHeaderUpload.single('media');

/**
 * Public GET /api/templates/:id/header-image
 * Serves permanently stored template header media from disk (or base64 fallback).
 */
exports.serveTemplateHeaderImage = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid template id' });
    }

    const template = await Template.findByPk(id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const vars =
      template.variables && typeof template.variables === 'object' && !Array.isArray(template.variables)
        ? template.variables
        : {};

    const { resolveUploadAbsolutePath } = require('../services/templateHeaderMediaStorage');
    const permanent =
      toPermanentUploadPath(vars.headerMediaUrl || vars.header_media_url || template.headerMediaUrl) ||
      null;

    if (permanent) {
      const abs = resolveUploadAbsolutePath(permanent);
      if (abs && fs.existsSync(abs)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return res.sendFile(abs);
      }
    }

    if (vars.headerMediaBase64) {
      const buffer = Buffer.from(String(vars.headerMediaBase64), 'base64');
      if (buffer.length) {
        const mime = String(vars.headerMediaMimeType || 'image/jpeg');
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return res.send(buffer);
      }
    }

    return res.status(404).json({ success: false, message: 'Template header image not found' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to serve template header image',
    });
  }
};

exports.uploadTemplateHeaderPreview = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;

    const templateName = String(req.body?.templateName || req.body?.name || '').trim();
    if (!templateName) {
      return res.status(400).json({ success: false, message: 'templateName is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No media file uploaded' });
    }

    const template = await Template.findOne({
      where: buildTemplateWhere(scope, { name: templateName }),
    });
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const storedPath = `/uploads/templates/${req.file.filename}`;
    const publicUrl = toPublicMediaUrl(storedPath);
    const vars =
      template.variables && typeof template.variables === 'object' && !Array.isArray(template.variables)
        ? { ...template.variables }
        : {};
    vars.headerMediaUrl = storedPath;
    template.set('variables', vars);
    template.changed('variables', true);

    await template.update({ variables: vars });

    return res.json({
      success: true,
      url: publicUrl,
      headerMediaUrl: publicUrl,
      headerMediaPath: storedPath,
      templateName,
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload template header preview',
    });
  }
};

const getMetaToken = () => {
  return process.env.WHATSAPP_TOKEN ||
    process.env.PERMANENT_TOKEN ||
    process.env.WA_ACCESS_TOKEN ||
    process.env.Whatsapp_Token;
};

const getMetaApiVersion = () => {
  return process.env.WHATSAPP_API_VERSION || 'v22.0';
};

/** Use linked WhatsApp account for the active project; optional strict mode skips cross-project fallback. */
async function resolveMetaCredentialsForRequest(req, { projectScopedOnly = false } = {}) {
  const envWaba = String(process.env.WABA_ID || process.env.WABAID || '').trim();
  const envToken = getMetaToken();
  const clientId = req.user?.id;

  if (clientId) {
    const projectId = getProjectId(req) || null;

    if (projectId) {
      const ownerId = await Project.getProjectOwnerId(projectId);
      const clientIds = [
        ...new Set([Number(clientId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0)),
      ];
      const scoped = await WhatsAppAccount.findOne({
        where: {
          client_id: { [Op.in]: clientIds },
          projectId: Number(projectId),
        },
        attributes: ['waba_id', 'access_token'],
        order: [['id', 'DESC']],
      });
      if (scoped) {
        const wabaId = String(scoped.waba_id || '').trim();
        const token = String(scoped.access_token || '').trim();
        if (wabaId && token) return { wabaId, token, source: 'whatsapp_accounts_scoped' };
      }
      if (projectScopedOnly) {
        return { wabaId: '', token: '', source: 'project_not_linked' };
      }
    } else if (projectScopedOnly) {
      return { wabaId: '', token: '', source: 'project_required' };
    }

    if (!projectScopedOnly) {
      const latest = await WhatsAppAccount.findOne({
        where: { client_id: Number(clientId) },
        attributes: ['waba_id', 'access_token'],
        order: [['id', 'DESC']],
      });
      if (latest) {
        const wabaId = String(latest.waba_id || '').trim();
        const token = String(latest.access_token || '').trim();
        if (wabaId && token) return { wabaId, token, source: 'whatsapp_accounts_latest' };
      }
    }
  }

  if (projectScopedOnly) {
    return { wabaId: '', token: '', source: 'project_not_linked' };
  }

  return { wabaId: envWaba, token: envToken, source: 'env' };
}

async function fetchAllMetaMessageTemplates(wabaId, token, apiVersion) {
  const all = [];
  let nextUrl = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  let useParams = { limit: 100 };
  let guard = 0;

  while (nextUrl && guard < 25) {
    const response = await axios.get(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
      ...(useParams ? { params: useParams } : {}),
    });
    all.push(...(response.data?.data || []));
    nextUrl = response.data?.paging?.next || null;
    useParams = null;
    guard += 1;
  }

  return all;
}

const normalizeComponentType = (t) => String(t || '').trim().toUpperCase();
const headerFormatToTemplateType = (format) => {
  const f = String(format || '').toUpperCase();
  if (f === 'IMAGE') return 'image';
  if (f === 'VIDEO') return 'video';
  if (f === 'DOCUMENT') return 'document';
  return 'text';
};
function enrichPlainTemplateCarouselMeta(plain) {
  if (!plain || typeof plain !== 'object') return plain;
  const vars =
    plain.variables && typeof plain.variables === 'object' && !Array.isArray(plain.variables)
      ? { ...plain.variables }
      : {};
  let carouselMeta = extractCarouselUiMetaFromComponents(vars.components || []);
  if (!carouselMeta && Array.isArray(vars.carouselCards) && vars.carouselCards.length) {
    carouselMeta = {
      templateType: 'carousel',
      carouselMediaType: vars.carouselMediaType || 'IMAGE',
      carouselCards: vars.carouselCards,
    };
  }
  if (carouselMeta) {
    plain.variables = { ...vars, ...carouselMeta };
  }
  if (plain.variables?.components?.length) {
    plain.components = plain.components || plain.variables.components;
  }
  return plain;
}

function extractCarouselUiMetaFromComponents(components) {
  const carousel = (components || []).find((c) => normalizeComponentType(c.type) === 'CAROUSEL');
  const cards = Array.isArray(carousel?.cards) ? carousel.cards : [];
  if (!cards.length) return null;

  let carouselMediaType = 'IMAGE';
  const carouselCards = cards.map((card, index) => {
    const inner = Array.isArray(card?.components) ? card.components : [];
    const cardHeader = inner.find((c) => normalizeComponentType(c.type) === 'HEADER');
    const cardBody = inner.find((c) => normalizeComponentType(c.type) === 'BODY');
    const buttonsComp = inner.find((c) => normalizeComponentType(c.type) === 'BUTTONS');
    if (cardHeader?.format) {
      carouselMediaType = String(cardHeader.format).toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE';
    }
    return {
      id: `card-${index + 1}`,
      body: String(cardBody?.text || '').trim(),
      buttons: (buttonsComp?.buttons || []).map((btn) => ({
        type: 'url',
        label: String(btn?.text || btn?.title || '').trim(),
        url: String(btn?.url || '').trim(),
      })),
    };
  });

  return {
    templateType: 'carousel',
    carouselMediaType,
    carouselCards,
  };
}

const buildTemplateVariablesMeta = (components, extra = {}) => {
  const header = (components || []).find((c) => normalizeComponentType(c.type) === 'HEADER');
  const carouselMeta = extractCarouselUiMetaFromComponents(components);
  const templateType =
    String(extra.templateType || '').trim().toLowerCase() ||
    carouselMeta?.templateType ||
    headerFormatToTemplateType(header?.format);
  const headerMediaUrl =
    extra.headerMediaUrl ||
    extra.header_media_url ||
    null;
  const bodyComp = (components || []).find((c) => normalizeComponentType(c.type) === 'BODY');
  return {
    templateType,
    components: Array.isArray(components) ? components : [],
    ...(headerMediaUrl ? { headerMediaUrl } : {}),
    ...(carouselMeta || {}),
    ...(bodyComp?.text && carouselMeta ? { carouselMainBody: String(bodyComp.text).trim() } : {}),
    ...extra,
  };
};

function ensureButtonsComponentInList(components, templateMeta) {
  const list = Array.isArray(components) ? [...components] : [];
  const existing = list.find((c) => normalizeComponentType(c.type) === 'BUTTONS');
  const existingButtons = Array.isArray(existing?.buttons)
    ? existing.buttons.filter((b) => String(b?.text || '').trim())
    : [];
  if (existingButtons.length) return list;

  const fromMeta = Array.isArray(templateMeta?.interactiveButtons)
    ? templateMeta.interactiveButtons.filter((b) => String(b?.text || '').trim())
    : [];
  if (!fromMeta.length) return list;

  const ctaButtons = fromMeta.filter((b) =>
    ['URL', 'PHONE_NUMBER'].includes(String(b.type || '').toUpperCase())
  );
  const qrButtons = fromMeta.filter((b) => String(b.type || '').toUpperCase() === 'QUICK_REPLY');
  const toAdd = ctaButtons.length ? ctaButtons.slice(0, 2) : qrButtons.slice(0, 3);
  if (!toAdd.length) return list;

  const without = list.filter((c) => normalizeComponentType(c.type) !== 'BUTTONS');
  return [...without, { type: 'BUTTONS', buttons: toAdd }];
}
const normalizeMetaTemplateName = (name) => {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
};

// Create template locally (save to database only)
exports.createTemplate = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { ownerId, projectId } = scope;
    const { name, content, category, variables } = req.body;

    const limitCheck = await enforcePlanLimit(req, res, 'templates', { projectId });
    if (limitCheck && !limitCheck.allowed) return;

    const template = await Template.create({
      userId: ownerId,
      projectId,
      name,
      content,
      category: category || 'other',
      variables: variables || [],
      status: 'draft'
    });

    res.status(201).json({
      success: true,
      template
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Submit template to Meta API for approval
exports.createMetaTemplate = async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        error: 'User not authenticated'
      });
    }
    
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { ownerId, projectId } = scope;
    const { name, category, language = "en_US", components: rawComponents, templateMeta, headerMedia, existingHeaderMediaUrl } = req.body;
    const components = ensureButtonsComponentInList(rawComponents, templateMeta);
    const metaLanguage = normalizeTemplateLanguageCode(language);
    const normalizedName = normalizeMetaTemplateName(name);

    // Validate input
    if (!name || !category || !components) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, category, components'
      });
    }
    if (!normalizedName) {
      return res.status(400).json({
        success: false,
        message: 'Invalid template name. Use letters/numbers/underscores only (Meta requirement).'
      });
    }
    if (normalizedName !== name) {
      console.warn(`⚠️ Normalizing template name for Meta: "${name}" → "${normalizedName}"`);
    }

    const limitCheck = await enforcePlanLimit(req, res, 'templates', { projectId });
    if (limitCheck && !limitCheck.allowed) return;

    const { wabaId: WABA_ID, token: TOKEN } = await resolveMetaCredentialsForRequest(req, {
      projectScopedOnly: true,
    });
    const apiVersion = getMetaApiVersion();

    if (!WABA_ID || !TOKEN) {
      return res.status(400).json({
        success: false,
        message:
          'WhatsApp is not linked for this project. Connect WhatsApp for this project before creating templates.',
      });
    }

    // Validate category (Meta API accepts: MARKETING, UTILITY, AUTHENTICATION)
    const validCategories = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
    const metaCategory = category.toUpperCase();
    if (!validCategories.includes(metaCategory)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${validCategories.join(', ')}`
      });
    }

    // Validate components structure
    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Components must be a non-empty array'
      });
    }

    let componentsForNormalize = Array.isArray(components) ? [...components] : [];
    const hasCarousel = componentsForNormalize.some(
      (c) => normalizeComponentType(c.type) === 'CAROUSEL'
    );
    let hasBody = componentsForNormalize.some((c) => normalizeComponentType(c.type) === 'BODY');

    if (hasCarousel && !hasBody) {
      const meta =
        templateMeta && typeof templateMeta === 'object' && !Array.isArray(templateMeta)
          ? templateMeta
          : {};
      let introText = String(meta.carouselMainBody || meta.content || '').trim();
      if (!introText) {
        const carouselComp = componentsForNormalize.find(
          (c) => normalizeComponentType(c.type) === 'CAROUSEL'
        );
        const firstCard = Array.isArray(carouselComp?.cards) ? carouselComp.cards[0] : null;
        const cardBody = (firstCard?.components || []).find(
          (c) => normalizeComponentType(c.type) === 'BODY'
        );
        introText = String(cardBody?.text || '').trim();
      }
      if (!introText) {
        introText = 'Browse the options below.';
      }
      componentsForNormalize = [{ type: 'BODY', text: introText }, ...componentsForNormalize];
      hasBody = true;
    }

    if (!hasBody && !hasCarousel) {
      return res.status(400).json({
        success: false,
        message: 'BODY component is required',
      });
    }

    if (hasCarousel && metaCategory !== 'MARKETING') {
      return res.status(400).json({
        success: false,
        message: 'Carousel templates must use the MARKETING category',
      });
    }

    const validComponentTypes = ['HEADER', 'BODY', 'FOOTER', 'BUTTONS', 'CAROUSEL'];
    for (const component of componentsForNormalize) {
      const normalizedType = normalizeComponentType(component.type);
      if (!validComponentTypes.includes(normalizedType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid component type: ${component.type}. Must be one of: ${validComponentTypes.join(', ')}`
        });
      }

      if (normalizedType === 'CAROUSEL') {
        const cards = Array.isArray(component.cards) ? component.cards : [];
        if (cards.length < 2 || cards.length > 10) {
          return res.status(400).json({
            success: false,
            message: 'Carousel templates must have between 2 and 10 cards',
          });
        }
        for (let i = 0; i < cards.length; i += 1) {
          const cardComps = Array.isArray(cards[i]?.components) ? cards[i].components : [];
          const cardBody = cardComps.find((c) => normalizeComponentType(c.type) === 'BODY');
          const cardHeader = cardComps.find((c) => normalizeComponentType(c.type) === 'HEADER');
          const cardButtons = cardComps.find((c) => normalizeComponentType(c.type) === 'BUTTONS');
          const bodyText = String(cardBody?.text || '').trim();
          if (!bodyText || bodyText.length > 160) {
            return res.status(400).json({
              success: false,
              message: `Card ${i + 1} body is required and must be at most 160 characters`,
            });
          }
          const headerFormat = String(cardHeader?.format || '').toUpperCase();
          if (!['IMAGE', 'VIDEO'].includes(headerFormat)) {
            return res.status(400).json({
              success: false,
              message: `Card ${i + 1} header must be IMAGE or VIDEO`,
            });
          }
          const buttons = Array.isArray(cardButtons?.buttons) ? cardButtons.buttons : [];
          if (buttons.length < 1 || buttons.length > 2) {
            return res.status(400).json({
              success: false,
              message: `Card ${i + 1} must have 1 or 2 buttons (URL only for carousel)`,
            });
          }
          for (const button of buttons) {
            if (String(button?.type || '').toUpperCase() !== 'URL') {
              return res.status(400).json({
                success: false,
                message: `Card ${i + 1} buttons must be URL type (Meta carousel requirement)`,
              });
            }
            if (!button.url || !String(button.url).startsWith('https://')) {
              return res.status(400).json({
                success: false,
                message: `Card ${i + 1} URL button must use a valid HTTPS URL`,
              });
            }
          }
        }
        const firstCardButtons =
          Array.isArray(cards[0]?.components)
            ? (cards[0].components.find((c) => normalizeComponentType(c.type) === 'BUTTONS')?.buttons ||
                [])
            : [];
        const expectedCount = firstCardButtons.length;
        for (let i = 1; i < cards.length; i += 1) {
          const cardComps = Array.isArray(cards[i]?.components) ? cards[i].components : [];
          const cardButtons = cardComps.find((c) => normalizeComponentType(c.type) === 'BUTTONS');
          const buttons = Array.isArray(cardButtons?.buttons) ? cardButtons.buttons : [];
          if (buttons.length !== expectedCount) {
            return res.status(400).json({
              success: false,
              message: 'All carousel cards must have the same number of buttons',
            });
          }
        }
        continue;
      }

      // Validate HEADER format
      if (normalizedType === 'HEADER') {
        const validFormats = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];
        if (!component.format || !validFormats.includes(component.format)) {
          return res.status(400).json({
            success: false,
            message: `HEADER format must be one of: ${validFormats.join(', ')}`
          });
        }
      }

      // Validate BUTTONS
      if (normalizedType === 'BUTTONS') {
        if (!component.buttons || !Array.isArray(component.buttons)) {
          return res.status(400).json({
            success: false,
            message: 'BUTTONS component must have a buttons array'
          });
        }
        if (component.buttons.length > 3) {
          return res.status(400).json({
            success: false,
            message: 'Maximum 3 buttons allowed per template'
          });
        }
        const validButtonTypes = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'OTP'];
        for (const button of component.buttons) {
          if (!validButtonTypes.includes(button.type)) {
            return res.status(400).json({
              success: false,
              message: `Invalid button type: ${button.type}. Must be one of: ${validButtonTypes.join(', ')}`
            });
          }

          // Validate button text length (1-20 characters for QUICK_REPLY)
          if (button.type === 'QUICK_REPLY' && (!button.text || button.text.length < 1 || button.text.length > 20)) {
            return res.status(400).json({
              success: false,
              message: 'QUICK_REPLY button text must be 1-20 characters'
            });
          }

          // Validate URL button
          if (button.type === 'URL') {
            if (!button.url || !button.url.startsWith('https://')) {
              return res.status(400).json({
                success: false,
                message: 'URL button must have a valid HTTPS URL'
              });
            }
            // Ensure example is an array (can be empty)
            if (button.example && !Array.isArray(button.example)) {
              return res.status(400).json({
                success: false,
                message: 'URL button example must be an array'
              });
            }
          }

          // Validate phone number button
          if (button.type === 'PHONE_NUMBER') {
            if (!button.phone_number || !button.phone_number.startsWith('+')) {
              return res.status(400).json({
                success: false,
                message: 'PHONE_NUMBER button must have a phone number starting with +'
              });
            }
          }

          // Validate OTP button (for AUTHENTICATION templates)
          if (button.type === 'OTP' && button.otp_type) {
            const validOtpTypes = ['COPY_CODE', 'ONE_TAP', 'ZERO_TAP'];
            const otpType = String(button.otp_type).toUpperCase();
            if (!validOtpTypes.includes(otpType)) {
              return res.status(400).json({
                success: false,
                message: `OTP button otp_type must be one of: ${validOtpTypes.join(', ')}`
              });
            }
          }
        }
      }
    }

    // Build Meta API payload
    // Important: Meta rejects unknown/extra fields. Sanitize each component to only allowed keys.
    // Also auto-generate BODY examples based on {{1}}, {{2}}, ... placeholders (Meta requires correct count + order).
    const generateSmartSample = (index, text) => {
      const t = String(text || '').toLowerCase();
      // Common patterns — keep values generic but realistic and policy-safe
      if (/\b(otp|one[\s-]?time\s+password|verification|verify|code)\b/.test(t)) return `code_${index}`;
      if (/\b(order|invoice|receipt|booking|ticket|reference|ref)\b/.test(t)) return `ref_${index}`;
      if (/\b(amount|total|price|cost|payment|paid|due|balance)\b/.test(t)) return `amount_${index}`;
      if (/\b(date|day|time|slot|schedule|delivery)\b/.test(t)) return `date_${index}`;
      if (/\b(name|customer|user)\b/.test(t)) return `name_${index}`;
      if (/\b(product|item|plan)\b/.test(t)) return `item_${index}`;
      if (/\b(location|address|city|state|country)\b/.test(t)) return `place_${index}`;
      // Fallback: fully generic
      return `value_${index}`;
    };

    const normalizedComponents = componentsForNormalize.map((c) => {
      const type = normalizeComponentType(c.type);

      const clean = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined || v === null) continue;
          out[k] = v;
        }
        return out;
      };

      const buildBodyExample = (text) => {
        const matches = String(text || '').match(/{{\d+}}/g);
        if (!matches || !matches.length) return null;
        const variableIndexes = [...new Set(matches.map((v) => parseInt(v.replace(/[{}]/g, ''), 10)))]
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
        if (!variableIndexes.length) return null;
        const sampleValues = variableIndexes.map((index) => generateSmartSample(index, text));
        return { body_text: [sampleValues] };
      };

      if (type === 'BODY') {
        const text = String(c.text || '').trim();
        const example = buildBodyExample(text);
        return clean({
          type,
          text,
          ...(example ? { example } : {})
        });
      }

      if (type === 'FOOTER') {
        return clean({
          type,
          text: String(c.text || '').trim()
        });
      }

      if (type === 'HEADER') {
        // Pass through only allowed keys depending on format.
        // For TEXT headers, Meta may accept example.header_text (array).
        // For media headers, the example shape differs; we keep any provided example object but strip unknown top-level keys.
        const header = clean({
          type,
          format: c.format ? String(c.format).trim().toUpperCase() : undefined,
          text: c.text != null ? String(c.text) : undefined,
          example: c.example && typeof c.example === 'object' ? c.example : undefined
        });
        // If header format is TEXT, ensure we don't accidentally send non-string text.
        if (header.format === 'TEXT' && typeof header.text !== 'string') header.text = String(header.text || '');
        return header;
      }

      if (type === 'BUTTONS') {
        const buttons = Array.isArray(c.buttons) ? c.buttons : [];
        const normalizedButtons = buttons.map((b) =>
          clean({
            type: b.type ? String(b.type).trim().toUpperCase() : undefined,
            text: b.text != null ? String(b.text) : undefined,
            url: b.url != null ? String(b.url) : undefined,
            phone_number: b.phone_number != null ? String(b.phone_number) : undefined,
            example: b.example && Array.isArray(b.example) ? b.example : undefined
          })
        );
        return clean({
          type,
          buttons: normalizedButtons
        });
      }

      if (type === 'CAROUSEL') {
        const cards = Array.isArray(c.cards) ? c.cards : [];
        const normalizedCards = cards.map((card) => {
          const inner = Array.isArray(card?.components) ? card.components : [];
          const normalizedInner = inner.map((innerComp) => {
            const innerType = normalizeComponentType(innerComp.type);
            if (innerType === 'HEADER') {
              return clean({
                type: innerType,
                format: innerComp.format ? String(innerComp.format).trim().toUpperCase() : undefined,
                example:
                  innerComp.example && typeof innerComp.example === 'object' ? innerComp.example : undefined,
              });
            }
            if (innerType === 'BODY') {
              const text = String(innerComp.text || '').trim();
              const example = buildBodyExample(text);
              return clean({
                type: innerType,
                text,
                ...(example ? { example } : {}),
              });
            }
            if (innerType === 'BUTTONS') {
              const buttons = Array.isArray(innerComp.buttons) ? innerComp.buttons : [];
              return clean({
                type: innerType,
                buttons: buttons.map((b) => {
                  const btnType = b.type ? String(b.type).trim().toUpperCase() : undefined;
                  let example = b.example && Array.isArray(b.example) ? b.example : undefined;
                  const url = b.url != null ? String(b.url) : undefined;
                  if (btnType === 'URL' && url && (!example || !example.length)) {
                    example = [url];
                  }
                  return clean({
                    type: btnType,
                    text: b.text != null ? String(b.text) : undefined,
                    url,
                    phone_number: b.phone_number != null ? String(b.phone_number) : undefined,
                    example,
                  });
                }),
              });
            }
            return clean({ type: innerType });
          });
          return { components: normalizedInner };
        });
        return clean({ type: 'CAROUSEL', cards: normalizedCards });
      }

      // Fallback: never send unknown component types
      return clean({ type });
    });

    // Meta AUTHENTICATION templates require OTP-specific component schema.
    // BODY.text is not allowed for this category, so we convert incoming UI data.
    const authNormalizedComponents = (() => {
      if (metaCategory !== 'AUTHENTICATION') return null;

      const footer = components.find(c => normalizeComponentType(c.type) === 'FOOTER');
      const footerText = String(footer?.text || '');
      const minutesMatch = footerText.match(/(\d{1,3})/);
      const parsedMinutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 5;
      const codeExpirationMinutes = Number.isFinite(parsedMinutes)
        ? Math.max(1, Math.min(parsedMinutes, 90))
        : 5;

      return [
        {
          type: 'BODY',
          add_security_recommendation: true
        },
        {
          type: 'FOOTER',
          code_expiration_minutes: codeExpirationMinutes
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'OTP',
              otp_type: 'COPY_CODE'
            }
          ]
        }
      ];
    })();

    let finalComponents = authNormalizedComponents || normalizedComponents;
    // Prefer uploaded base64; otherwise reuse a permanently stored /uploads header image
    let resolvedHeaderMedia = headerMedia;
    if (!resolvedHeaderMedia?.data && existingHeaderMediaUrl) {
      resolvedHeaderMedia = loadHeaderMediaFromUpload(existingHeaderMediaUrl);
    }

    // Persist header image to disk BEFORE Meta submit so View/Copy/Inbox always have a permanent file
    let savedHeaderMediaUrl = null;
    if (resolvedHeaderMedia?.data) {
      try {
        savedHeaderMediaUrl = saveTemplateHeaderMediaToUploads(resolvedHeaderMedia, normalizedName);
      } catch (mediaSaveErr) {
        console.warn('Could not persist template header preview image:', mediaSaveErr.message);
      }
    }
    if (!savedHeaderMediaUrl && existingHeaderMediaUrl) {
      try {
        savedHeaderMediaUrl =
          copyTemplateHeaderMedia(existingHeaderMediaUrl, normalizedName) ||
          toPermanentUploadPath(existingHeaderMediaUrl);
      } catch (copyErr) {
        console.warn('Could not copy existing template header image:', copyErr.message);
        savedHeaderMediaUrl = toPermanentUploadPath(existingHeaderMediaUrl);
      }
    }
    if (savedHeaderMediaUrl) {
      savedHeaderMediaUrl = toPermanentUploadPath(savedHeaderMediaUrl) || savedHeaderMediaUrl;
    }

    if (!authNormalizedComponents) {
      try {
        finalComponents = await enrichComponentsWithHeaderExamples(normalizedComponents, {
          accessToken: TOKEN,
          headerMedia: resolvedHeaderMedia,
        });
      } catch (mediaErr) {
        const mediaMessage = formatAxiosMetaError(mediaErr);
        console.error('Header media preparation failed:', mediaMessage);
        return res.status(400).json({
          success: false,
          message: mediaMessage || 'Failed to prepare header media for Meta',
        });
      }
    }

    const metaPayload = {
      name: normalizedName,
      category: metaCategory,
      language: metaLanguage,
      components: finalComponents
    };

    console.log('📤 Submitting template to Meta API:', JSON.stringify(metaPayload, null, 2));

    // Submit to Meta API
    const url = `https://graph.facebook.com/${apiVersion}/${WABA_ID}/message_templates`;
    let response;
    try {
      response = await withMetaRateLimitRetry(() =>
        axios.post(url, metaPayload, {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          },
        })
      );
      console.log('✅ Template submitted to Meta API:', response.data);
      
      // Validate response structure
      if (!response || !response.data) {
        throw new Error('Invalid response from Meta API: response.data is undefined');
      }
    } catch (apiError) {
      console.error("Meta API Error:", apiError?.response?.data || apiError.message);
      const metaErr = apiError?.response?.data?.error;
      const errorMsg =
        metaErr?.error_user_msg ||
        metaErr?.error_user_title ||
        metaErr?.message ||
        apiError.message ||
        "Failed to submit template";
      
      return res.status(500).json({
        success: false,
        message: `Failed to submit template to Meta: ${errorMsg}`,
        error: apiError?.response?.data || apiError.message,
        headerMediaUrl: savedHeaderMediaUrl || null,
        headerMediaPublicUrl: savedHeaderMediaUrl ? toPublicMediaUrl(savedHeaderMediaUrl) : null,
      });
    }

    // Extract body text from components for local storage
    const bodyComponent = normalizedComponents.find(c => normalizeComponentType(c.type) === 'BODY');
    let bodyText = bodyComponent?.text || name;
    if (!bodyComponent) {
      const carouselComp = normalizedComponents.find((c) => normalizeComponentType(c.type) === 'CAROUSEL');
      const firstCard = Array.isArray(carouselComp?.cards) ? carouselComp.cards[0] : null;
      const firstCardBody = (firstCard?.components || []).find(
        (c) => normalizeComponentType(c.type) === 'BODY'
      );
      if (firstCardBody?.text) bodyText = firstCardBody.text;
    }

    // Extract template features for better storage
    const hasHeader = normalizedComponents.some(c => normalizeComponentType(c.type) === 'HEADER');
    const hasButtons = normalizedComponents.some(c => normalizeComponentType(c.type) === 'BUTTONS');
    const hasFooter = normalizedComponents.some(c => normalizeComponentType(c.type) === 'FOOTER');
    const buttonCount = hasButtons ? normalizedComponents.find(c => normalizeComponentType(c.type) === 'BUTTONS')?.buttons?.length || 0 : 0;
    
    console.log('📋 Template features:', {
      hasHeader,
      hasButtons,
      hasFooter,
      buttonCount,
      headerFormat: hasHeader ? normalizedComponents.find(c => normalizeComponentType(c.type) === 'HEADER')?.format : null,
      headerMediaUrl: savedHeaderMediaUrl,
    });

    // Map Meta category to our category enum
    let localCategory = 'other';
    if (metaCategory === 'MARKETING') localCategory = 'marketing';
    else if (metaCategory === 'UTILITY') localCategory = 'utility';
    else if (metaCategory === 'AUTHENTICATION') localCategory = 'notification';

    // Save to local database with PENDING status
    let template;

    try {
      // Check if template already exists
      const existingTemplate = await Template.findOne({
        where: buildTemplateWhere(scope, { name: normalizedName }),
      });

      if (existingTemplate && isTemplateRowDeleted(existingTemplate)) {
        return res.status(409).json({
          success: false,
          message: 'This template was deleted and cannot be recreated automatically.',
        });
      }

      const deletedLookup = await getDeletedTemplateLookup(projectId);
      if (isTemplateDeletedInLookup(deletedLookup, normalizedName, null)) {
        return res.status(409).json({
          success: false,
          message: 'This template was deleted and cannot be recreated automatically.',
        });
      }

      if (!savedHeaderMediaUrl && existingTemplate?.variables?.headerMediaUrl) {
        savedHeaderMediaUrl = toPermanentUploadPath(existingTemplate.variables.headerMediaUrl)
          || existingTemplate.variables.headerMediaUrl;
      }
      if (savedHeaderMediaUrl) {
        savedHeaderMediaUrl = toPermanentUploadPath(savedHeaderMediaUrl) || savedHeaderMediaUrl;
      }

      const variablesMeta = buildTemplateVariablesMeta(normalizedComponents, {
        templateType: templateMeta?.templateType,
        language: metaLanguage,
        actionMode: templateMeta?.actionMode,
        callToActions: templateMeta?.callToActions,
        quickReplies: templateMeta?.quickReplies,
        footer: templateMeta?.footer,
        interactiveButtons: templateMeta?.interactiveButtons,
        carouselMediaType: templateMeta?.carouselMediaType,
        carouselCards: templateMeta?.carouselCards,
        carouselMainBody: templateMeta?.carouselMainBody,
      });
      // Keep header image permanently on the template for UI / send reuse
      if (savedHeaderMediaUrl) {
        variablesMeta.headerMediaUrl = savedHeaderMediaUrl;
        variablesMeta.header_media_url = savedHeaderMediaUrl;
        if (String(templateMeta?.templateType || '').toLowerCase() === 'image'
          || normalizedComponents.some((c) => String(c?.type || '').toUpperCase() === 'HEADER' && String(c?.format || '').toUpperCase() === 'IMAGE')) {
          variablesMeta.templateType = 'image';
        }
      }

      if (existingTemplate) {
        existingTemplate.set('variables', variablesMeta);
        existingTemplate.changed('variables', true);
        await existingTemplate.update({
          content: bodyText,
          category: localCategory,
          status: 'draft',
          variables: variablesMeta,
        });
        template = existingTemplate;
        console.log('✅ Updated existing template:', name, 'headerMediaUrl=', savedHeaderMediaUrl);
      } else {
        template = await Template.create({
          userId: ownerId,
          projectId,
          name: normalizedName,
          content: bodyText,
          category: localCategory,
          status: 'draft',
          variables: variablesMeta,
        });
        console.log('✅ Created new template:', name, 'headerMediaUrl=', savedHeaderMediaUrl);
      }
    } catch (dbError) {
      console.error("Database Error saving template:", dbError);
      // Still return success if Meta API succeeded, even if DB save failed
    }

    // Meta API response contains template ID and status
    const metaTemplateId = response?.data?.id || null;
    const metaStatus = response?.data?.status || 'PENDING';
    const rejectionReason = response?.data?.rejection_reason || null;
    const qualityRating = response?.data?.quality_rating || null;

    // Persist Meta identifiers + rejection reason for UI visibility
    try {
      if (template) {
        await template.update({
          metaTemplateId,
          metaStatus,
          rejectionReason: metaStatus === 'REJECTED' ? rejectionReason : null
        });
      }
    } catch (e) {
      console.error('⚠️ Failed to persist Meta template status fields:', e.message);
    }

    // Log rejection details if available
    if (metaStatus === 'REJECTED') {
      console.error('❌ Template REJECTED by Meta:', {
        templateId: metaTemplateId,
        rejectionReason: rejectionReason,
        qualityRating: qualityRating,
        fullResponse: JSON.stringify(response.data, null, 2)
      });
    }

    return res.json({
      success: true,
      message: metaStatus === 'REJECTED' 
        ? "Template submitted but REJECTED by Meta. Check rejectionReason for details."
        : "Template submitted to Meta for approval",
      metaTemplateId: metaTemplateId,
      status: metaStatus,
      rejectionReason: rejectionReason,
      qualityRating: qualityRating,
      headerMediaUrl: savedHeaderMediaUrl ? toPublicMediaUrl(savedHeaderMediaUrl) : null,
      headerMediaPublicUrl: savedHeaderMediaUrl ? toPublicMediaUrl(savedHeaderMediaUrl) : null,
      template: template
        ? (() => {
            const plain = template.toJSON ? template.toJSON() : template;
            // Re-fetch may be stale; attach public header URL for UI immediately
            if (savedHeaderMediaUrl) {
              const publicUrl = toPublicMediaUrl(savedHeaderMediaUrl);
              const vars =
                plain.variables && typeof plain.variables === 'object' && !Array.isArray(plain.variables)
                  ? { ...plain.variables }
                  : {};
              vars.headerMediaUrl = publicUrl;
              vars.header_media_url = publicUrl;
              return { ...plain, variables: vars, headerMediaUrl: publicUrl, header_media_url: publicUrl };
            }
            return plain;
          })()
        : null
    });
  } catch (error) {
    console.error("Create Meta Template Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create template",
      error: error.message
    });
  }
};

exports.getTemplates = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { projectId } = scope;
    const { category, status, page = 1, limit = 20 } = req.query;

    const where = buildActiveTemplateWhere(scope);
    if (category) where.category = category;
    if (status) where.status = status;

    const offset = (page - 1) * limit;

    let templates = [];
    try {
      const result = await Template.findAndCountAll({
        where,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        order: [['createdAt', 'DESC']],
      });
      templates = result.rows;
    } catch (error) {
      if (!/deletedAt|Unknown column/i.test(String(error.message || ''))) throw error;
      const fallbackWhere = { ...buildTemplateWhere(scope) };
      if (category) fallbackWhere.category = category;
      if (status) fallbackWhere.status = status;
      const result = await Template.findAndCountAll({
        where: fallbackWhere,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        order: [['createdAt', 'DESC']],
      });
      templates = result.rows;
    }

    const enrichedTemplates = await enrichTemplatesWithBroadcastHeader(templates, projectId);
    const deletedLookup = await getDeletedTemplateLookup(projectId);
    const visibleTemplates = enrichedTemplates
      .filter((row) => isTemplateVisible(row, deletedLookup))
      .map((row) => {
        const raw = row.get ? row.get({ plain: true }) : { ...row };
        return enrichPlainTemplateCarouselMeta(raw);
      });

    res.json({
      success: true,
      templates: visibleTemplates,
      pagination: {
        total: visibleTemplates.length,
        page: parseInt(page),
        pages: Math.max(1, Math.ceil(visibleTemplates.length / limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.getTemplateById = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { projectId } = scope;
    const { id } = req.params;

    let template = await Template.findOne({
      where: buildActiveTemplateWhere(scope, { id }),
    });

    // Allow lookup by Meta template id as well, so clients can use either local id or metaTemplateId.
    if (!template) {
      template = await Template.findOne({
        where: buildActiveTemplateWhere(scope, { metaTemplateId: String(id) }),
      });
    }

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const [enriched] = await enrichTemplatesWithBroadcastHeader([template], projectId);
    let plain = enriched?.get ? enriched.get({ plain: true }) : enriched || template;
    plain = enrichPlainTemplateCarouselMeta(plain);

    const stillMissingCarousel =
      String(plain?.variables?.templateType || '').toLowerCase() !== 'carousel' &&
      !(Array.isArray(plain?.variables?.carouselCards) && plain.variables.carouselCards.length);
    if (stillMissingCarousel && plain?.name) {
      try {
        const scopeUserId = scope.userId || plain.userId;
        const metaComponents = await fetchMetaTemplateComponentsByName(
          plain.name,
          scopeUserId,
          projectId
        );
        if (metaComponents.length) {
          const mergedVars = buildTemplateVariablesMeta(metaComponents, plain.variables || {});
          plain.variables = mergedVars;
          plain.components = mergedVars.components;
          plain = enrichPlainTemplateCarouselMeta(plain);
        }
      } catch (metaErr) {
        console.warn('getTemplateById carousel meta fetch:', metaErr?.message || metaErr);
      }
    }

    res.json({
      success: true,
      template: plain
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { id } = req.params;
    const { name, content, category, variables } = req.body;

    const template = await Template.findOne({
      where: buildTemplateWhere(scope, { id }),
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    if (name) template.name = name;
    if (content) template.content = content;
    if (category) template.category = category;
    if (variables) template.variables = variables;

    await template.save();

    res.json({
      success: true,
      template
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { id } = req.params;

    const template = await Template.findOne({
      where: buildActiveTemplateWhere(scope, { id }),
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const templateName = template.name;
    const metaTemplateId = template.metaTemplateId;
    const templateDbId = Number(template.id);

    const markedCount = await markTemplatesDeleted(scope, {
      id: templateDbId,
      name: templateName,
      metaTemplateId,
    });

    if (!markedCount) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    await ProjectApiToken.update(
      { templateId: null },
      { where: { projectId: scope.projectId, templateId: templateDbId } }
    );

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Get templates from Meta WhatsApp API and save to database
exports.getMetaTemplates = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { projectId, ownerId } = scope;
    const { wabaId: WABA_ID, token: TOKEN, source: credSource } =
      await resolveMetaCredentialsForRequest(req, { projectScopedOnly: true });
    const apiVersion = getMetaApiVersion();

    if (!WABA_ID || !TOKEN) {
      return res.status(200).json({
        success: true,
        templates: [],
        whatsappRequired: true,
        message:
          'WhatsApp is not linked for this project. Connect WhatsApp for this project before syncing templates.',
      });
    }

    console.log(`📥 Fetching Meta templates for WABA ${WABA_ID} (credentials: ${credSource})`);

    const metaTemplates = await fetchAllMetaMessageTemplates(WABA_ID, TOKEN, apiVersion);
    const savedTemplates = [];
    const updatedTemplates = [];
    const errors = [];

    console.log(`📥 Fetched ${metaTemplates.length} templates from Meta API`);

    const deletedLookup = await getDeletedTemplateLookup(projectId);

    // Save each template to database
    for (const metaTemplate of metaTemplates) {
      try {
        if (isTemplateDeletedInLookup(deletedLookup, metaTemplate.name, metaTemplate.id)) {
          continue;
        }

        // Check if template already exists (by name and userId)
        const existingTemplate = await Template.findOne({
          where: buildTemplateWhere(scope, { name: metaTemplate.name }),
        });

        if (existingTemplate && isTemplateRowDeleted(existingTemplate)) {
          continue;
        }

        if (
          existingTemplate &&
          isTemplateDeletedInLookup(deletedLookup, existingTemplate.name, existingTemplate.metaTemplateId)
        ) {
          continue;
        }

        // Extract body text from components
        const bodyComponent = metaTemplate.components?.find(c => c.type === 'BODY');
        const bodyText = bodyComponent?.text || metaTemplate.name;

        // Map Meta category to our category enum
        let category = 'other';
        if (metaTemplate.category === 'MARKETING') category = 'marketing';
        else if (metaTemplate.category === 'UTILITY') category = 'utility';
        else if (metaTemplate.category === 'AUTHENTICATION') category = 'notification';

        // Map Meta status to our status enum
        // Meta statuses: APPROVED, REJECTED, PENDING
        let status = 'draft';
        if (metaTemplate.status === 'APPROVED') status = 'approved';
        else if (metaTemplate.status === 'REJECTED') status = 'rejected';
        else if (metaTemplate.status === 'PENDING') status = 'draft'; // PENDING maps to draft in our system

        const existingVars =
          existingTemplate?.variables &&
          typeof existingTemplate.variables === 'object' &&
          !Array.isArray(existingTemplate.variables)
            ? existingTemplate.variables
            : {};

        const fromMeta = buildTemplateVariablesMeta(metaTemplate.components || []);
        const isCarouselTemplate =
          String(existingVars.templateType || '').toLowerCase() === 'carousel' ||
          String(fromMeta.templateType || '').toLowerCase() === 'carousel';
        const mergedVariables = {
          ...fromMeta,
          templateType: isCarouselTemplate ? 'carousel' : fromMeta.templateType,
          carouselMediaType:
            existingVars.carouselMediaType || fromMeta.carouselMediaType || 'IMAGE',
          carouselCards:
            Array.isArray(existingVars.carouselCards) && existingVars.carouselCards.length
              ? existingVars.carouselCards
              : fromMeta.carouselCards,
          carouselMainBody:
            existingVars.carouselMainBody ||
            fromMeta.carouselMainBody ||
            (metaTemplate.components?.find((c) => c.type === 'BODY')?.text || null),
          components: metaTemplate.components || fromMeta.components || existingVars.components,
          headerMediaUrl:
            toPermanentUploadPath(existingVars.headerMediaUrl || existingVars.header_media_url) ||
            existingVars.headerMediaUrl ||
            existingVars.header_media_url ||
            null,
          interactiveButtons: existingVars.interactiveButtons,
          callToActions: existingVars.callToActions,
          quickReplies: existingVars.quickReplies,
          actionMode: existingVars.actionMode,
          footer: existingVars.footer,
          language: existingVars.language,
        };

        // Prepare template data
        const templateData = {
          userId: ownerId,
          projectId,
          name: metaTemplate.name,
          content: bodyText,
          category: category,
          status: status,
          variables: mergedVariables,
          metaTemplateId: metaTemplate.id ? String(metaTemplate.id) : null,
          metaStatus: metaTemplate.status || null,
          rejectionReason:
            metaTemplate.status === 'REJECTED'
              ? (metaTemplate.rejection_reason || metaTemplate.reason || null)
              : null
        };

        if (existingTemplate) {
          // Update existing template
          await existingTemplate.update(templateData);
          updatedTemplates.push(existingTemplate);
          console.log(`✅ Updated template: ${metaTemplate.name}`);
        } else {
          // Create new template
          const newTemplate = await Template.create(templateData);
          savedTemplates.push(newTemplate);
          console.log(`✅ Saved new template: ${metaTemplate.name}`);
        }
      } catch (saveError) {
        console.error(`❌ Error saving template ${metaTemplate.name}:`, saveError.message);
        errors.push({
          name: metaTemplate.name,
          error: saveError.message
        });
      }
    }

    // Return templates for current project; approved first for UI / sending.
    const projectTemplates = await findTemplatesForList(buildActiveTemplateWhere(scope), {
      projectId,
      order: [
        [
          Template.sequelize.literal(
            "CASE WHEN status = 'approved' OR metaStatus = 'APPROVED' THEN 0 ELSE 1 END"
          ),
          'ASC',
        ],
        ['updatedAt', 'DESC'],
      ],
      attributes: [
        'id',
        'name',
        'category',
        'status',
        'metaStatus',
        'content',
        'variables',
        'metaTemplateId',
        'updatedAt',
        'createdAt',
      ],
    });

    const metaByName = new Map(
      metaTemplates.map((t) => [String(t.name || '').toLowerCase(), t])
    );
    const templatesPayload = projectTemplates.map((row) => {
      const plain = row.get ? row.get({ plain: true }) : { ...row };
      const meta = metaByName.get(String(plain.name || '').toLowerCase());
      if (meta?.components) {
        plain.components = meta.components;
      }
      const vars = plain.variables;
      const hasType =
        vars &&
        typeof vars === 'object' &&
        !Array.isArray(vars) &&
        String(vars.templateType || '').trim();
      if (!hasType && meta?.components) {
        plain.variables = {
          ...buildTemplateVariablesMeta(meta.components),
          headerMediaUrl: vars?.headerMediaUrl || vars?.header_media_url || null,
          interactiveButtons: vars?.interactiveButtons,
          callToActions: vars?.callToActions,
          quickReplies: vars?.quickReplies,
          actionMode: vars?.actionMode,
          footer: vars?.footer,
          language: vars?.language,
        };
      }
      return plain;
    });

    const enrichedTemplatesPayload = await enrichTemplatesWithBroadcastHeader(
      templatesPayload,
      projectId
    );
    const visibleTemplatesPayload = enrichedTemplatesPayload.filter((row) =>
      isTemplateVisible(row, deletedLookup)
    );

    return res.json({
      success: true,
      templates: visibleTemplatesPayload,
      statusSummary: {
        approved: metaTemplates.filter(t => t.status === 'APPROVED').length,
        rejected: metaTemplates.filter(t => t.status === 'REJECTED').length,
        pending: metaTemplates.filter(t => t.status === 'PENDING' || !t.status).length,
        total: metaTemplates.length
      },
      saved: {
        new: savedTemplates.length,
        updated: updatedTemplates.length,
        errors: errors.length,
        total: savedTemplates.length + updatedTemplates.length
      },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error("Meta API Error:", error.response?.data || error);
    // Ensure error is a string so frontend never shows [object Object]
    let errorMessage = error.message || "Unknown error";
    if (error.response?.data) {
      const d = error.response.data;
      if (typeof d === "string") errorMessage = d;
      else if (d.error?.message) errorMessage = d.error.message;
      else if (d.message) errorMessage = d.message;
      else if (d.error) errorMessage = typeof d.error === "string" ? d.error : JSON.stringify(d.error);
      else errorMessage = JSON.stringify(d);
    }
    // Meta "does not exist" or "missing permissions" = config issue, not server bug
    const isMetaConfigError = error.response?.status === 400 || error.response?.status === 403 ||
      /does not exist|cannot be loaded due to missing permissions|does not support this operation/i.test(errorMessage);
    const hint = isMetaConfigError
      ? " Fix: Use your WhatsApp Business Account ID (WABA ID) in .env WABA_ID — find it in Meta Business Suite → WhatsApp → API Setup. Ensure your token has whatsapp_business_management permission."
      : "";
    return res.status(isMetaConfigError ? 400 : 500).json({
      success: false,
      message: "Failed to fetch templates from Meta",
      error: errorMessage + hint
    });
  }
};

// Get detailed template information from Meta (including rejection reasons)
exports.getMetaTemplateDetails = async (req, res) => {
  try {
    const scope = await resolveTemplateScope(req, res);
    if (!scope) return;
    const { projectId, userId } = scope;
    const { templateId } = req.params;

    if (!templateId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID is required',
      });
    }

    const result = await fetchMetaTemplateById(templateId, userId, projectId);

    if (result.template) {
      return res.json({
        success: true,
        template: result.template,
        source: result.source,
      });
    }

    const status = Number(result.status) || 404;
    const message =
      result.error?.error?.message ||
      result.error?.message ||
      'Failed to fetch template details from Meta';

    logApiFailure({
      direction: 'outbound',
      operation: 'META_GET_TEMPLATE_BY_ID',
      method: 'GET',
      url: `graph.facebook.com/${getMetaApiVersion()}/${templateId}`,
      status,
      message,
      userId,
      projectId,
      response: result.error || null,
    });

    return res.status(status >= 400 && status < 600 ? status : 404).json({
      success: false,
      message,
      error: result.error || null,
    });
  } catch (error) {
    console.error('Get Meta Template Details Error:', error);
    logApiFailure({
      direction: 'inbound',
      operation: 'GET_META_TEMPLATE_DETAILS',
      method: req.method,
      path: req.originalUrl || req.url,
      status: 500,
      userId: req.user?.id ?? null,
      projectId: getProjectId(req) || req.user?.projectId || null,
      message: error.message || 'Failed to get template details',
      error,
    });
    return res.status(500).json({
      success: false,
      message: 'Failed to get template details',
      error: error.message,
    });
  }
};

