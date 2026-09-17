const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User, PartnerBusiness, WhatsAppAccount } = require('../models');
const Project = require('../models/Project');

function getEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(String(process.env.JWT_SECRET || 'waabizx-partner-secret'))
    .digest();
}

function encryptSecret(plain) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(encoded) {
  if (!encoded) return '';
  const buf = Buffer.from(String(encoded), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function generateBusinessId() {
  return crypto.randomBytes(12).toString('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeContact(contact) {
  return String(contact || '').replace(/\D/g, '').trim();
}

function buildCreateBusinessResponse(row) {
  const projectPublicId = String(row.external_project_id || row.project_id || '').trim();
  return {
    id: row.business_id,
    display_name: row.display_name,
    email: row.email,
    active: row.active !== false,
    project_ids: projectPublicId ? [projectPublicId] : [],
  };
}

async function createPartnerBusiness(partnerId, payload = {}) {
  const displayName = String(payload.display_name || '').trim();
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '').trim();
  const company = String(payload.company || displayName || '').trim();
  const contact = normalizeContact(payload.contact);
  const currency = String(payload.currency || 'INR').trim().toUpperCase();
  const timezone = String(payload.timezone || 'Asia/Calcutta GMT+05:30').trim();

  if (!displayName) {
    const err = new Error('display_name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!email) {
    const err = new Error('email is required');
    err.statusCode = 400;
    throw err;
  }
  if (!password || password.length < 4) {
    const err = new Error('password is required (min 4 characters)');
    err.statusCode = 400;
    throw err;
  }

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    const err = new Error('A user with this email already exists');
    err.statusCode = 409;
    throw err;
  }

  const user = await User.create({
    name: displayName,
    email,
    password,
    role: 'admin',
    mobileNumber: contact && contact.length >= 10 ? contact : null,
  });

  const projectId = await Project.create(user.id, company || displayName);
  await User.update({ projectId }, { where: { id: user.id } });

  const businessId = generateBusinessId();
  const externalProjectId = generateBusinessId();
  const row = await PartnerBusiness.create({
    business_id: businessId,
    external_project_id: externalProjectId,
    partner_id: String(partnerId),
    user_id: user.id,
    project_id: projectId,
    display_name: displayName,
    company,
    contact: contact || null,
    email,
    currency,
    timezone,
    active: true,
    direct_api_password_enc: encryptSecret(password),
  });

  return {
    business: row,
    user,
    projectId,
    plainPassword: password,
    response: buildCreateBusinessResponse(row),
    directApi: {
      email,
      password,
      projectId: externalProjectId,
      base64Key: Buffer.from(`${email}:${password}:${externalProjectId}`, 'utf8').toString('base64'),
    },
  };
}

async function findPartnerBusiness(partnerId, businessId) {
  return PartnerBusiness.findOne({
    where: {
      partner_id: String(partnerId),
      business_id: String(businessId),
    },
  });
}

async function findPartnerBusinessByProject(projectId) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return PartnerBusiness.findOne({
    where: { project_id: pid, active: true },
    order: [['id', 'DESC']],
  });
}

async function findPartnerBusinessByExternalProjectId(externalProjectId) {
  const ext = String(externalProjectId || '').trim();
  if (!ext) return null;
  return PartnerBusiness.findOne({
    where: { external_project_id: ext, active: true },
    order: [['id', 'DESC']],
  });
}

async function resolvePartnerBusinessRow(projectIdOrExternal, opts = {}) {
  const raw = String(projectIdOrExternal || '').trim();
  if (!raw) return null;
  const requireActive = opts.requireActive !== false;
  let row = null;
  const pid = Number(raw);
  if (Number.isInteger(pid) && pid > 0) {
    row = await PartnerBusiness.findOne({
      where: requireActive ? { project_id: pid, active: true } : { project_id: pid },
      order: [['id', 'DESC']],
    });
  }
  if (!row) {
    row = await PartnerBusiness.findOne({
      where: requireActive
        ? { external_project_id: raw, active: true }
        : { external_project_id: raw },
      order: [['id', 'DESC']],
    });
  }
  return row;
}

function extractAssistantIdFromJwt(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(String(token || ''));
    if (!decoded || typeof decoded !== 'object') return '';
    return String(decoded.assistantId || decoded.projectId || decoded.clientId || '').trim();
  } catch (_) {
    return '';
  }
}

async function getDirectApiCredentialPartsForProject(projectIdOrExternal) {
  const row = await resolvePartnerBusinessRow(projectIdOrExternal);
  if (!row) return null;
  const projectPublicId = String(row.external_project_id || '').trim();
  if (!projectPublicId) return null;
  const password = decryptSecret(row.direct_api_password_enc);
  return {
    email: row.email,
    password: password || null,
    projectId: projectPublicId,
    source: 'partner_businesses',
    businessId: row.business_id,
    localProjectId: row.project_id,
  };
}

/**
 * Load stored Direct API JWT Bearer for one account (partner business / AiSensy project).
 * Returns null if missing or expired (with 60s skew).
 */
async function getStoredDirectApiJwt(projectIdOrExternal) {
  const row = await resolvePartnerBusinessRow(projectIdOrExternal);
  if (!row) return null;
  const token = String(row.direct_api_jwt || '').trim();
  if (!token) return null;
  if (row.direct_api_jwt_expires_at) {
    const expiresAt = new Date(row.direct_api_jwt_expires_at).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) {
      return null;
    }
  }
  return {
    token,
    expiresAt: row.direct_api_jwt_expires_at ? new Date(row.direct_api_jwt_expires_at) : null,
    businessId: row.business_id,
    projectId: String(row.external_project_id || row.project_id || '').trim(),
    localProjectId: row.project_id,
  };
}

/**
 * Persist AiSensy Direct API JWT Bearer on the matching partner_businesses row.
 * Lookup order: projectId/external id → JWT assistantId → email (+ assistantId).
 * Returns { ok, row?, reason? }.
 */
async function saveDirectApiJwt(projectIdOrExternal, token, expiresAt = null, hints = {}) {
  const jwtToken = String(token || '').trim();
  if (!jwtToken) {
    return { ok: false, reason: 'empty_token' };
  }

  const assistantId = extractAssistantIdFromJwt(jwtToken);
  const email = normalizeEmail(hints.email);

  // include inactive rows for JWT persist (account may be temporarily inactive)
  let row = await resolvePartnerBusinessRow(projectIdOrExternal, { requireActive: false });
  if (!row && assistantId) {
    row = await resolvePartnerBusinessRow(assistantId, { requireActive: false });
  }
  if (!row && email && assistantId) {
    row = await PartnerBusiness.findOne({
      where: { email, external_project_id: assistantId },
      order: [['id', 'DESC']],
    });
  }
  const rawLookup = String(projectIdOrExternal || '').trim();
  const isLocalProjectLookup = /^\d+$/.test(rawLookup) && Number(rawLookup) > 0;
  if (!row && email && !isLocalProjectLookup && !assistantId) {
    row = await PartnerBusiness.findOne({
      where: { email },
      order: [['id', 'DESC']],
    });
  }

  if (!row) {
    return {
      ok: false,
      reason: 'no_partner_business_row',
      projectIdOrExternal: String(projectIdOrExternal || ''),
      assistantId,
      email: email || null,
    };
  }

  const fields = { direct_api_jwt: jwtToken };
  if (expiresAt != null) {
    fields.direct_api_jwt_expires_at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  } else {
    fields.direct_api_jwt_expires_at = null;
  }
  // Keep external_project_id aligned with JWT assistantId when missing
  if (assistantId && !String(row.external_project_id || '').trim()) {
    fields.external_project_id = assistantId;
  }

  await row.update(fields);
  await row.reload();
  return {
    ok: true,
    row,
    id: row.id,
    project_id: row.project_id,
    external_project_id: row.external_project_id,
    assistantId,
  };
}

async function clearDirectApiJwt(projectIdOrExternal) {
  const row = await resolvePartnerBusinessRow(projectIdOrExternal);
  if (!row) return false;
  await row.update({ direct_api_jwt: null, direct_api_jwt_expires_at: null });
  return true;
}

async function ensurePartnerBusinessForUserProject(userId, projectId, opts = {}) {
  const uid = Number(userId);
  const pid = Number(projectId);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const existing = await findPartnerBusinessByProject(pid);
  if (existing) return existing;

  const user = await User.findByPk(uid);
  const project = await Project.findById(pid);
  if (!user || !project || Number(project.user_id) !== uid) {
    return null;
  }

  const partnerId =
    String(opts.partnerId || process.env.AISENSY_PARTNER_ID || process.env.PARTNER_ID || 'waabizx').trim();

  const plainPassword = crypto.randomBytes(9).toString('base64url');
  const hashed = await bcrypt.hash(plainPassword, 10);
  await user.update({ password: hashed });

  const businessId = generateBusinessId();
  const externalProjectId = generateBusinessId();
  const row = await PartnerBusiness.create({
    business_id: businessId,
    external_project_id: externalProjectId,
    partner_id: partnerId,
    user_id: uid,
    project_id: pid,
    display_name: String(project.project_name || user.name || '').trim() || user.name,
    company: String(project.project_name || '').trim() || null,
    contact: user.mobileNumber || null,
    email: user.email,
    currency: 'INR',
    timezone: 'Asia/Calcutta GMT+05:30',
    active: true,
    direct_api_password_enc: encryptSecret(plainPassword),
  });

  row.setDataValue('generatedPassword', plainPassword);
  return row;
}

/**
 * AiSensy links a WABA to one assistant (external_project_id). New local projects get
 * new assistant IDs but share the same WABA — Direct API must use the assistant that
 * actually owns the WABA or Meta returns error #10.
 */
async function resolveCanonicalAisensyAssistantId(userId, localProjectId) {
  const uid = Number(userId);
  const pid = Number(localProjectId);
  const envCanonical = String(
    process.env.AISENSY_DIRECT_API_PROJECT_ID || process.env.AISENSY_PROJECT_ID || ''
  ).trim();

  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return envCanonical || null;
  }

  const localWa = await WhatsAppAccount.findOne({
    where: { client_id: uid, projectId: pid },
    order: [['id', 'DESC']],
  });
  const wabaId = String(localWa?.waba_id || '').trim();

  if (!wabaId) {
    const row = await findPartnerBusinessByProject(pid);
    return String(row?.external_project_id || envCanonical || '').trim() || null;
  }

  const originWa = await WhatsAppAccount.findOne({
    where: { client_id: uid, waba_id: wabaId },
    order: [['id', 'ASC']],
  });
  const originProjectId = Number(originWa?.projectId);
  if (Number.isInteger(originProjectId) && originProjectId > 0) {
    const originPartner = await findPartnerBusinessByProject(originProjectId);
    const originExt = String(originPartner?.external_project_id || '').trim();
    if (originExt) return originExt;
  }

  const localPartner = await findPartnerBusinessByProject(pid);
  if (localPartner?.business_id) {
    const sibling = await PartnerBusiness.findOne({
      where: { user_id: uid, business_id: localPartner.business_id, active: true },
      order: [['id', 'ASC']],
    });
    const siblingExt = String(sibling?.external_project_id || '').trim();
    if (siblingExt) return siblingExt;
  }

  if (envCanonical) return envCanonical;

  return String(localPartner?.external_project_id || '').trim() || null;
}

module.exports = {
  createPartnerBusiness,
  findPartnerBusiness,
  findPartnerBusinessByProject,
  findPartnerBusinessByExternalProjectId,
  resolvePartnerBusinessRow,
  extractAssistantIdFromJwt,
  getDirectApiCredentialPartsForProject,
  getStoredDirectApiJwt,
  saveDirectApiJwt,
  clearDirectApiJwt,
  ensurePartnerBusinessForUserProject,
  resolveCanonicalAisensyAssistantId,
  buildCreateBusinessResponse,
  encryptSecret,
  decryptSecret,
};
