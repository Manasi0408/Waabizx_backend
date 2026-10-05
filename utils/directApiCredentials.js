const bcrypt = require('bcryptjs');
const { User } = require('../models');
const Project = require('../models/Project');
const {
  findPartnerBusinessByExternalProjectId,
  decryptSecret,
} = require('../services/partnerBusinessService');

const looksLikeBcryptHash = (value) =>
  typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);

function parseDirectApiCredentialBearer(authHeader) {
  const raw = String(authHeader || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  const encoded = raw.slice(7).trim();
  if (!encoded) return null;

  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  } catch (_) {
    return null;
  }
  if (!decoded) return null;

  const parts = decoded.split(':');
  if (parts.length < 3) return null;

  const username = String(parts[0] || '').trim();
  const projectId = String(parts[parts.length - 1] || '').trim();
  const password = parts.slice(1, -1).join(':');
  if (!username || !password || !projectId) return null;

  return { username, password, projectId };
}

async function verifyUserPassword(user, password) {
  if (looksLikeBcryptHash(user.password)) {
    return user.comparePassword(password);
  }
  return String(user.password).trim() === String(password).trim();
}

async function verifyDirectApiPassword(user, password, projectIdRaw) {
  if (await verifyUserPassword(user, password)) return true;

  const raw = String(projectIdRaw || '').trim();
  const partnerRow = await findPartnerBusinessByExternalProjectId(raw);
  if (partnerRow && String(partnerRow.email || '').toLowerCase() === String(user.email).toLowerCase()) {
    const stored = decryptSecret(partnerRow.direct_api_password_enc);
    if (stored && String(stored) === String(password)) return true;
  }

  const envEmail = String(process.env.AISENSY_DIRECT_API_EMAIL || '').trim().toLowerCase();
  const envPass = String(process.env.AISENSY_DIRECT_API_PASSWORD || '').trim();
  const envProj = String(process.env.AISENSY_DIRECT_API_PROJECT_ID || '').trim();
  if (
    envEmail &&
    envPass &&
    envProj &&
    envProj === raw &&
    envEmail === String(user.email).toLowerCase() &&
    envPass === String(password)
  ) {
    return true;
  }

  return false;
}

async function userCanAccessProject(user, projectIdRaw) {
  const raw = String(projectIdRaw || '').trim();
  const projectIdNum = Number(raw);

  if (Number.isInteger(projectIdNum) && projectIdNum > 0) {
    const project = await Project.findById(projectIdNum);
    if (!project) {
      return { ok: false, reason: 'Project not found' };
    }
    const uid = Number(user.id);
    const ownerId = Number(project.user_id);
    const userProjectId = Number(user.projectId);
    if (uid === ownerId) {
      return { ok: true, project, ownerId };
    }
    if (userProjectId === projectIdNum) {
      return { ok: true, project, ownerId };
    }
    return { ok: false, reason: 'Project access denied' };
  }

  const partnerRow = await findPartnerBusinessByExternalProjectId(raw);
  if (!partnerRow) {
    const envProj = String(process.env.AISENSY_DIRECT_API_PROJECT_ID || '').trim();
    const envEmail = String(process.env.AISENSY_DIRECT_API_EMAIL || '').trim().toLowerCase();
    if (envProj === raw && envEmail === String(user.email).toLowerCase()) {
      const pid = Number(user.projectId);
      let project = null;
      if (Number.isInteger(pid) && pid > 0) {
        project = await Project.findById(pid);
      }
      if (!project) {
        const owned = await Project.findByUser(user.id);
        project = Array.isArray(owned) && owned.length ? owned[0] : null;
      }
      if (project) {
        return { ok: true, project, ownerId: Number(user.id), externalProjectId: raw };
      }
    }
    return { ok: false, reason: 'Invalid project id' };
  }
  const uid = Number(user.id);
  const ownerId = Number(partnerRow.user_id);
  if (uid !== ownerId && Number(user.projectId) !== Number(partnerRow.project_id)) {
    return { ok: false, reason: 'Project access denied' };
  }
  const project = await Project.findById(partnerRow.project_id);
  if (!project) {
    return { ok: false, reason: 'Project not found' };
  }
  return { ok: true, project, ownerId, externalProjectId: raw };
}

async function authenticateDirectApiCredentials(authHeader) {
  const creds = parseDirectApiCredentialBearer(authHeader);
  if (!creds) {
    const err = new Error('Invalid Key');
    err.statusCode = 401;
    throw err;
  }

  const email = creds.username.toLowerCase();
  const user = await User.findOne({ where: { email } });
  if (!user) {
    const err = new Error('Invalid Key');
    err.statusCode = 401;
    throw err;
  }

  if (String(user.status || 'active').toLowerCase() === 'suspended') {
    const err = new Error('Account suspended');
    err.statusCode = 403;
    throw err;
  }

  const passwordOk = await verifyDirectApiPassword(user, creds.password, creds.projectId);
  if (!passwordOk) {
    const err = new Error('Invalid Key');
    err.statusCode = 401;
    throw err;
  }

  const access = await userCanAccessProject(user, creds.projectId);
  if (!access.ok) {
    const err = new Error(access.reason === 'Project not found' ? 'Invalid Key' : access.reason);
    err.statusCode = access.reason === 'Project not found' ? 401 : 403;
    throw err;
  }

  return {
    user,
    project: access.project,
    projectId: access.externalProjectId
      ? Number(access.project?.id)
      : Number(creds.projectId),
    externalProjectId: access.externalProjectId || String(creds.projectId),
    ownerId: access.ownerId,
  };
}

module.exports = {
  parseDirectApiCredentialBearer,
  authenticateDirectApiCredentials,
};
