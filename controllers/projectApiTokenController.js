const { Op } = require('sequelize');
const Project = require('../models/Project');
const Template = require('../models/Template');
const { ProjectApiToken } = require('../models');
const { verifyProjectAccess } = require('../middleware/projectAccess');
const { getProjectId } = require('../utils/projectScope');
const { applyDirectApiCorsHeaders } = require('../middleware/directApiCors');
const {
  generateApiToken,
  hashApiToken,
  validateIpv4,
  validateDomainUrl,
  isProjectWhatsAppConnected,
  resolveRequestOrigin,
  originsMatch,
  ipsMatch,
} = require('../services/apiTokenService');
const { getClientIp } = require('../utils/geoCountry');

function resolveProjectId(req) {
  const fromBody = Number(req.body?.projectId);
  if (Number.isInteger(fromBody) && fromBody > 0) return fromBody;
  return getProjectId(req);
}

async function loadProjectAndVerify(req, res) {
  const projectId = resolveProjectId(req);
  if (!projectId) {
    res.status(400).json({
      success: false,
      message: 'Project ID is required',
    });
    return null;
  }

  const allowed = await verifyProjectAccess(req, res, projectId);
  if (!allowed) return null;

  const project = await Project.findById(projectId);
  if (!project) {
    res.status(404).json({
      success: false,
      message: 'Project not found',
    });
    return null;
  }

  const whatsappConnected = await isProjectWhatsAppConnected(projectId);
  if (!whatsappConnected) {
    res.status(403).json({
      success: false,
      message: 'Connect WhatsApp before creating an API token',
    });
    return null;
  }

  return { project, projectId };
}

async function resolveActiveProjectApiToken(req) {
  const auth = String(req.headers.authorization || req.headers.Authorization || '').trim();
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { error: 'API token is required in Authorization header', status: 401 };
  }

  return { token };
}

function normalizePhoneInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, message: 'Phone number is required in request body.' };
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return { ok: false, message: 'Enter a valid phone number (10–15 digits).' };
  }
  return { ok: true, value: digits };
}

async function resolveLinkedTemplateId(activeToken, projectId) {
  const rawTemplateId = activeToken?.templateId;
  if (rawTemplateId == null || rawTemplateId === '') {
    return null;
  }

  const templateId = Number(rawTemplateId);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    await activeToken.update({ templateId: null }, { fields: ['templateId'] });
    return null;
  }

  const linkedTemplate = await Template.findOne({
    where: { id: templateId, projectId: Number(projectId) },
    attributes: ['id'],
  });

  if (!linkedTemplate) {
    await activeToken.update({ templateId: null }, { fields: ['templateId'] });
    return null;
  }

  return templateId;
}

exports.getStatus = async (req, res) => {
  try {
    const ctx = await loadProjectAndVerify(req, res);
    if (!ctx) return undefined;

    const activeToken = await ProjectApiToken.findOne({
      where: {
        projectId: ctx.projectId,
        isActive: true,
      },
      order: [['createdAt', 'DESC']],
    });

    if (!activeToken) {
      return res.json({
        success: true,
        hasToken: false,
        whatsappConnected: true,
      });
    }

    if (!activeToken.tokenPlain) {
      const token = generateApiToken();
      await activeToken.update({
        tokenPlain: token,
        tokenHash: hashApiToken(token),
        tokenPrefix: token.substring(0, 12),
      });
      await activeToken.reload();
    }

    const templateId = await resolveLinkedTemplateId(activeToken, ctx.projectId);

    return res.json({
      success: true,
      hasToken: true,
      whatsappConnected: true,
      token: {
        id: activeToken.id,
        token: activeToken.tokenPlain || null,
        tokenPrefix: activeToken.tokenPrefix,
        allowedIp: activeToken.allowedIp,
        allowedDomain: activeToken.allowedDomain,
        templateId,
        createdAt: activeToken.createdAt,
      },
    });
  } catch (error) {
    console.error('Get API token status error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch API token status',
    });
  }
};

exports.createToken = async (req, res) => {
  try {
    const ctx = await loadProjectAndVerify(req, res);
    if (!ctx) return undefined;

    const { allowedIp, allowedDomain, replaceExisting } = req.body || {};

    const ipCheck = validateIpv4(allowedIp);
    if (!ipCheck.ok) {
      return res.status(400).json({ success: false, message: ipCheck.message });
    }

    const domainCheck = validateDomainUrl(allowedDomain);
    if (!domainCheck.ok) {
      return res.status(400).json({ success: false, message: domainCheck.message });
    }

    const existing = await ProjectApiToken.findOne({
      where: {
        projectId: ctx.projectId,
        isActive: true,
      },
    });

    if (existing && !replaceExisting) {
      return res.status(409).json({
        success: false,
        code: 'TOKEN_EXISTS',
        message: 'An API token already exists for this project.',
        token: {
          id: existing.id,
          tokenPrefix: existing.tokenPrefix,
          allowedIp: existing.allowedIp,
          allowedDomain: existing.allowedDomain,
          templateId: existing.templateId,
          createdAt: existing.createdAt,
        },
      });
    }

    if (existing && replaceExisting) {
      await ProjectApiToken.destroy({ where: { projectId: ctx.projectId } });
    }

    const token = generateApiToken();
    const tokenHash = hashApiToken(token);
    const tokenPrefix = token.substring(0, 12);

    await ProjectApiToken.create({
      projectId: ctx.projectId,
      projectName: String(ctx.project.project_name || ctx.project.name || 'Project').trim(),
      tokenPrefix,
      tokenHash,
      tokenPlain: token,
      allowedIp: ipCheck.value,
      allowedDomain: domainCheck.value,
      isActive: true,
    });

    return res.status(201).json({
      success: true,
      message: 'API token created successfully',
      token,
      warning: 'Save this token securely. It will not be shown again.',
    });
  } catch (error) {
    console.error('Create API token error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create API token',
    });
  }
};

exports.updateToken = async (req, res) => {
  try {
    const ctx = await loadProjectAndVerify(req, res);
    if (!ctx) return undefined;

    const { allowedIp, allowedDomain, regenerateToken } = req.body || {};

    const ipCheck = validateIpv4(allowedIp);
    if (!ipCheck.ok) {
      return res.status(400).json({ success: false, message: ipCheck.message });
    }

    const domainCheck = validateDomainUrl(allowedDomain);
    if (!domainCheck.ok) {
      return res.status(400).json({ success: false, message: domainCheck.message });
    }

    const activeToken = await ProjectApiToken.findOne({
      where: {
        projectId: ctx.projectId,
        isActive: true,
      },
    });

    if (!activeToken) {
      return res.status(404).json({
        success: false,
        message: 'No active API token found for this project',
      });
    }

    if (regenerateToken) {
      const token = generateApiToken();
      const tokenHash = hashApiToken(token);
      const tokenPrefix = token.substring(0, 12);

      await activeToken.update({
        projectName: String(ctx.project.project_name || ctx.project.name || 'Project').trim(),
        tokenPrefix,
        tokenHash,
        tokenPlain: token,
        allowedIp: ipCheck.value,
        allowedDomain: domainCheck.value,
        isActive: true,
      });

      return res.json({
        success: true,
        message: 'API token updated successfully',
        token,
        warning: 'Save this token securely. It will not be shown again.',
      });
    }

    await activeToken.update({
      allowedIp: ipCheck.value,
      allowedDomain: domainCheck.value,
    });

    return res.json({
      success: true,
      message: 'API token settings updated successfully',
    });
  } catch (error) {
    console.error('Update API token error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update API token',
    });
  }
};

exports.setTemplate = async (req, res) => {
  try {
    const ctx = await loadProjectAndVerify(req, res);
    if (!ctx) return undefined;

    const templateIdRaw = req.body?.templateId;
    const templateId =
      templateIdRaw == null || templateIdRaw === ''
        ? null
        : Number(templateIdRaw);

    if (templateId != null && (!Number.isInteger(templateId) || templateId <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid template ID',
      });
    }

    const activeToken = await ProjectApiToken.findOne({
      where: {
        projectId: ctx.projectId,
        isActive: true,
      },
    });

    if (!activeToken) {
      return res.status(404).json({
        success: false,
        message: 'Create an API token before selecting a template',
      });
    }

    if (templateId != null) {
      const linkedTemplate = await Template.findOne({
        where: { id: templateId, projectId: ctx.projectId },
        attributes: ['id'],
      });
      if (!linkedTemplate) {
        return res.status(404).json({
          success: false,
          message: 'Template not found for this project',
        });
      }
    }

    await activeToken.update(
      { templateId: templateId == null ? null : templateId },
      { fields: ['templateId'] }
    );

    return res.json({
      success: true,
      message: templateId ? 'Template linked to API token' : 'Template removed from API token',
      templateId,
    });
  } catch (error) {
    console.error('Set API token template error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save template selection',
    });
  }
};

exports.revokeToken = async (req, res) => {
  try {
    const ctx = await loadProjectAndVerify(req, res);
    if (!ctx) return undefined;

    const activeToken = await ProjectApiToken.findOne({
      where: {
        projectId: ctx.projectId,
        isActive: true,
      },
    });

    if (!activeToken) {
      return res.status(404).json({
        success: false,
        message: 'No active API token found for this project',
      });
    }

    await ProjectApiToken.destroy({ where: { projectId: ctx.projectId } });

    return res.json({
      success: true,
      message: 'API token deleted successfully',
    });
  } catch (error) {
    console.error('Revoke API token error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to revoke API token',
    });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const auth = String(req.headers.authorization || req.headers.Authorization || '').trim();
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const remoteAddress = getClientIp(req);
    const origin = resolveRequestOrigin(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'API token is required in Authorization header',
        remoteAddress,
        origin,
      });
    }

    const tokenHash = hashApiToken(token);
    const apiToken = await ProjectApiToken.findOne({
      where: {
        isActive: true,
        [Op.or]: [{ tokenHash }, { tokenPlain: token }],
      },
    });

    if (!apiToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API token',
        remoteAddress,
        origin,
      });
    }

    if (origin && originsMatch(origin, apiToken.allowedDomain)) {
      applyDirectApiCorsHeaders(res, origin);
    }

    if (apiToken.allowedIp && !ipsMatch(remoteAddress, apiToken.allowedIp)) {
      return res.status(403).json({
        success: false,
        message: 'Request IP does not match the allowed IP for this token',
        remoteAddress,
        origin,
        allowedIp: apiToken.allowedIp,
      });
    }

    if (apiToken.allowedDomain && origin && !originsMatch(origin, apiToken.allowedDomain)) {
      return res.status(403).json({
        success: false,
        message: 'Request origin does not match the allowed domain for this token',
        remoteAddress,
        origin,
        allowedDomain: apiToken.allowedDomain,
      });
    }

    return res.json({
      success: true,
      remoteAddress,
      origin,
      token,
      allowedIp: apiToken.allowedIp || null,
      allowedDomain: apiToken.allowedDomain || null,
      ...body,
    });
  } catch (error) {
    console.error('Send message error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send message',
    });
  }
};

exports.welcomePage = (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send('welcome to waabizx');
};