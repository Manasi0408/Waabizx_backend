const Project = require('../models/Project');
const { listProjectsForUser, userHasProjectAccess } = require('../services/agentProjectService');
const { WhatsAppAccount } = require('../models');
const db = require('../config/db');
const axios = require('axios');
const { bootstrapNewProjectWhatsApp } = require('../services/newProjectWhatsAppService');

const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';

/** AiSensy assigns this shared sandbox number until Meta Embedded Signup verifies a real WABA. */
const AISENSY_SANDBOX_WA_NUMBERS = new Set(['919810765443', '9810765443', '+919810765443']);

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isSandboxWaNumber(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) return false;
  if (AISENSY_SANDBOX_WA_NUMBERS.has(digits)) return true;
  return [...AISENSY_SANDBOX_WA_NUMBERS].some(
    (s) => normalizePhoneDigits(s) === digits || digits.endsWith(normalizePhoneDigits(s).slice(-10))
  );
}

const toDisplayPhone = async (phoneNumberId, token) => {
  if (!phoneNumberId || !token) return null;
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'display_phone_number,verified_name' },
        timeout: 10000,
      }
    );
    return resp?.data?.display_phone_number || null;
  } catch (_) {
    return null;
  }
};

const attachProjectPhoneNumbers = async (projects) => {
  if (!Array.isArray(projects) || projects.length === 0) return projects;

  const projectIds = projects.map((p) => Number(p.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (projectIds.length === 0) return projects;

  const placeholders = projectIds.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT wa.projectId, wa.phone_number_id, wa.access_token, wa.display_phone
     FROM whatsapp_accounts wa
     INNER JOIN (
       SELECT projectId, MAX(id) AS max_id
       FROM whatsapp_accounts
       WHERE projectId IN (${placeholders})
       GROUP BY projectId
     ) latest ON latest.max_id = wa.id`,
    projectIds
  );

  const waByProject = new Map();
  (rows || []).forEach((r) => {
    waByProject.set(Number(r.projectId), {
      phoneNumberId: String(r.phone_number_id || '').trim(),
      accessToken: String(r.access_token || '').trim(),
      displayPhone: String(r.display_phone || '').trim(),
    });
  });

  // Fallback: latest mapped customer phone from clients_whatsapp (not owner signup mobile)
  const [clientPhoneRows] = await db.query(
    `SELECT cw.project_id, cw.phone
     FROM clients_whatsapp cw
     INNER JOIN (
       SELECT project_id, MAX(id) AS max_id
       FROM clients_whatsapp
       WHERE project_id IN (${placeholders}) AND phone IS NOT NULL AND TRIM(phone) <> ''
       GROUP BY project_id
     ) latest ON latest.max_id = cw.id`,
    projectIds
  );
  const clientPhoneByProject = new Map();
  (clientPhoneRows || []).forEach((r) => {
    clientPhoneByProject.set(Number(r.project_id), String(r.phone || '').trim());
  });

  // Billing / Razorpay contact (owner mobile) — shown separately, never as WhatsApp number
  const ownerIds = projects.map((p) => Number(p.user_id)).filter((id) => Number.isInteger(id) && id > 0);
  const uniqueOwnerIds = Array.from(new Set(ownerIds));
  let ownerMobileByUser = new Map();
  if (uniqueOwnerIds.length > 0) {
    const ownerPlaceholders = uniqueOwnerIds.map(() => '?').join(',');
    const [ownerRows] = await db.query(
      `SELECT id, mobile_number
       FROM users
       WHERE id IN (${ownerPlaceholders})`,
      uniqueOwnerIds
    );
    ownerMobileByUser = new Map(
      (ownerRows || []).map((r) => [Number(r.id), String(r.mobile_number || '').trim()])
    );
  }

  const resolved = await Promise.all(
    projects.map(async (p) => {
      const pid = Number(p.id);
      const mapping = waByProject.get(pid) || {};
      const phoneNumberId =
        mapping.phoneNumberId ||
        String(p.whatsapp_number_id || '').trim() ||
        null;
      const token =
        mapping.accessToken ||
        process.env.WHATSAPP_TOKEN ||
        process.env.PERMANENT_TOKEN ||
        process.env.Whatsapp_Token ||
        '';

      const liveDisplayPhone = await toDisplayPhone(phoneNumberId, token);
      const storedDisplayPhone =
        mapping.displayPhone ||
        String(p.whatsapp_display_phone || '').trim() ||
        null;
      const mappedPhone = clientPhoneByProject.get(pid) || null;
      const ownerPhone = ownerMobileByUser.get(Number(p.user_id)) || null;

      // Prefer Meta-connected WhatsApp number only — never AiSensy sandbox / owner signup mobile.
      const candidates = [liveDisplayPhone, storedDisplayPhone, mappedPhone].filter(Boolean);
      const waLine =
        candidates.find((n) => n && !isSandboxWaNumber(n)) || null;

      return {
        ...p,
        whatsappNumber: waLine,
        whatsapp_number: waLine,
        paymentPhone: ownerPhone || null,
      };
    })
  );

  return resolved;
};

/** Mark projects approved when WhatsApp Business is fully linked for that project (WABA + phone_number_id). */
const attachWhatsAppApprovalStatus = async (projects) => {
  if (!Array.isArray(projects) || projects.length === 0) return projects;

  const projectIds = projects.map((p) => Number(p.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (projectIds.length === 0) return projects;

  const placeholders = projectIds.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT DISTINCT projectId
     FROM whatsapp_accounts
     WHERE projectId IN (${placeholders})
       AND projectId IS NOT NULL
       AND TRIM(COALESCE(waba_id, '')) <> ''
       AND TRIM(COALESCE(phone_number_id, '')) <> ''`,
    projectIds
  );
  const approvedSet = new Set((rows || []).map((r) => Number(r.projectId)));

  return projects.map((p) => {
    const pid = Number(p.id);
    const whatsappLive = approvedSet.has(pid);
    const prev = String(p.status || '').trim();
    const nextStatus = whatsappLive ? 'approved' : prev || 'pending';
    return {
      ...p,
      status: nextStatus,
      whatsappApproved: whatsappLive,
    };
  });
};

// Create Project
exports.createProject = async (req, res) => {
  try {
    const { project_name } = req.body || {};

    if (!project_name || String(project_name).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Project name is required',
      });
    }

    const projectId = await Project.create(req.user.id, String(project_name).trim());
    const project = await Project.findById(projectId);

    let whatsappBootstrap = null;
    try {
      whatsappBootstrap = await bootstrapNewProjectWhatsApp(
        req.user.id,
        projectId,
        String(project_name).trim()
      );
    } catch (bootstrapErr) {
      console.warn('[createProject] WhatsApp bootstrap:', bootstrapErr?.message || bootstrapErr);
      whatsappBootstrap = {
        connected: false,
        requiresWhatsAppConnect: true,
        message: bootstrapErr?.message || 'Connect WhatsApp for this project',
      };
    }

    res.status(201).json({
      success: true,
      message: whatsappBootstrap?.connected
        ? 'Project created and WhatsApp linked'
        : 'Project created successfully — connect WhatsApp to send templates',
      projectId,
      project,
      whatsappConnected: Boolean(whatsappBootstrap?.connected),
      requiresWhatsAppConnect: Boolean(whatsappBootstrap?.requiresWhatsAppConnect),
      whatsappBootstrap,
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: error.message,
      code: error.code || undefined,
    });
  }
};

// Get Projects (Role Based)
exports.getProjects = async (req, res) => {
  try {
    let projects;
    const requesterRole = String(req.user?.role || '').toLowerCase();

    if (requesterRole === 'super_admin') {
      // Super admin sees all projects across accounts.
      projects = await Project.findAll();
    } else if (requesterRole === 'manager' || requesterRole === 'agent') {
      projects = await listProjectsForUser(req.user);
    } else {
      // Admin sees only their own account projects.
      projects = await Project.findByUser(req.user.id);
    }

    projects = await attachProjectPhoneNumbers(projects);
    projects = await attachWhatsAppApprovalStatus(projects);

    res.json({
      success: true,
      count: projects.length,
      projects,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get Single Project
exports.getProjectById = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase();
    const requesterUserId = Number(req.user?.id);
    const projectOwnerId = Number(project.user_id);
    const projectIdNum = Number(project.id);
    const isSuperAdmin = requesterRole === 'super_admin';
    const isOwner =
      Number.isInteger(requesterUserId) && requesterUserId > 0 && projectOwnerId === requesterUserId;
    const hasTeamAccess =
      (requesterRole === 'manager' || requesterRole === 'agent') &&
      (await userHasProjectAccess(req.user, projectIdNum));

    if (!isSuperAdmin && !isOwner && !hasTeamAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    const [withPhone] = await attachProjectPhoneNumbers([project]);
    const [withStatus] = await attachWhatsAppApprovalStatus([withPhone || project]);

    res.json({
      success: true,
      project: withStatus || withPhone || project,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get WhatsApp phone quality rating for a project (Meta Graph — token stays server-side)
exports.getQualityRating = async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid project id' });
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase();
    const requesterUserId = Number(req.user?.id);
    const requesterProjectId = Number(req.user?.projectId);
    const projectOwnerId = Number(project.user_id);
    const isSuperAdmin = requesterRole === 'super_admin';
    const isOwner =
      Number.isInteger(requesterUserId) && requesterUserId > 0 && projectOwnerId === requesterUserId;
    const isAssignedManager =
      requesterRole === 'manager' &&
      Number.isInteger(requesterProjectId) &&
      requesterProjectId > 0 &&
      projectId === requesterProjectId;
    const isAssignedAgent =
      requesterRole === 'agent' &&
      Number.isInteger(requesterProjectId) &&
      requesterProjectId > 0 &&
      projectId === requesterProjectId;

    if (!isSuperAdmin && !isOwner && !isAssignedManager && !isAssignedAgent) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }

    const account = await WhatsAppAccount.findOne({
      where: { projectId },
      order: [['id', 'DESC']],
    });

    const phoneNumberId = String(account?.phone_number_id || '').trim();
    const accessToken = String(account?.access_token || '').trim();

    if (!phoneNumberId || !accessToken) {
      return res.status(404).json({
        success: false,
        message: 'WhatsApp account not linked for this project',
      });
    }

    const response = await axios.get(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
      {
        params: { fields: 'quality_rating' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
        validateStatus: () => true,
      }
    );

    if (response.status >= 400) {
      return res.status(502).json({
        success: false,
        error: response.data?.error || response.data || `Meta API error (${response.status})`,
      });
    }

    return res.status(200).json({
      success: true,
      qualityRating: response.data?.quality_rating || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
};

// Hide / unhide project (admin or project owner)
exports.setProjectHidden = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase();
    if (requesterRole === 'manager') {
      return res.status(403).json({
        success: false,
        message: 'Managers are not allowed to hide projects.',
      });
    }

    const requesterUserId = Number(req.user?.id);
    const projectOwnerId = Number(project.user_id);
    const isSuperAdmin = requesterRole === 'super_admin';
    const isOwner = Number.isInteger(requesterUserId) && requesterUserId > 0 && projectOwnerId === requesterUserId;

    if (!isSuperAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    const hiddenRaw = req.body?.hidden ?? req.body?.is_hidden;
    const hidden =
      hiddenRaw === true ||
      hiddenRaw === 1 ||
      hiddenRaw === '1' ||
      String(hiddenRaw || '').toLowerCase() === 'true';

    await Project.setHidden(req.params.id, hidden);

    res.json({
      success: true,
      message: hidden ? 'Project hidden' : 'Project unhidden',
      hidden,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Delete Project (admin or project owner)
exports.deleteProject = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase();
    if (requesterRole === 'manager') {
      return res.status(403).json({
        success: false,
        message: 'Managers are not allowed to delete projects.',
      });
    }

    const requesterUserId = Number(req.user?.id);
    const projectOwnerId = Number(project.user_id);
    const isSuperAdmin = requesterRole === 'super_admin';
    const isOwner = Number.isInteger(requesterUserId) && requesterUserId > 0 && projectOwnerId === requesterUserId;

    if (!isSuperAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    await Project.delete(req.params.id);

    res.json({
      success: true,
      message: 'Project deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

