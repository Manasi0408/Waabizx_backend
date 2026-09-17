const { PartnerBusiness, WhatsAppAccount, User } = require('../models');
const db = require('../config/db');
const {
  resolveAisensyBusinessId,
  createProject,
  submitFacebookAccessToken,
  verifyBusinessOnAisensy,
  verifyProjectOnAisensyBusiness,
} = require('./aisensyPartnerService');
const {
  regenerateTokenDirectApi,
  resolveCredentialParts,
} = require('./aisensyDirectApiClient');
const { encryptSecret } = require('./partnerBusinessService');

function isFullyLinkedAccount(account) {
  if (!account) return false;
  return Boolean(
    String(account.waba_id || '').trim() &&
      String(account.phone_number_id || '').trim() &&
      String(account.access_token || '').trim()
  );
}

async function savePartnerBusinessForProject({
  user,
  localProjectId,
  aisensyBusinessId,
  aisensyProjectId,
  plainPassword,
  projectName,
}) {
  const partnerId = String(
    process.env.AISENSY_PARTNER_ID || process.env.PARTNER_ID || ''
  ).trim();
  const existing = await PartnerBusiness.findOne({
    where: { user_id: user.id, project_id: localProjectId, active: true },
    order: [['id', 'DESC']],
  });
  const fields = {
    business_id: String(aisensyBusinessId),
    external_project_id: String(aisensyProjectId),
    partner_id: partnerId || existing?.partner_id || 'aisensy',
    user_id: user.id,
    project_id: localProjectId,
    display_name: String(projectName || user.name || user.email).trim(),
    company: String(projectName || '').trim() || null,
    contact: String(user.mobileNumber || '').replace(/\D/g, '') || null,
    email: String(user.email || '')
      .trim()
      .toLowerCase(),
    currency: 'INR',
    timezone: 'Asia/Calcutta GMT+05:30',
    active: true,
  };
  if (plainPassword) {
    fields.direct_api_password_enc = encryptSecret(plainPassword);
  }
  if (existing) {
    await existing.update(fields);
    return existing;
  }
  return PartnerBusiness.create(fields);
}

async function ensureAisensyPartnerRow(user, localProjectId, projectName) {
  let partnerRow = await PartnerBusiness.findOne({
    where: { user_id: user.id, project_id: localProjectId, active: true },
    order: [['id', 'DESC']],
  });
  const storedBusinessId = String(partnerRow?.business_id || '').trim();
  const storedProjectId = String(partnerRow?.external_project_id || '').trim();
  if (storedBusinessId && storedProjectId) {
    const businessOk = await verifyBusinessOnAisensy(storedBusinessId);
    const projectOk = businessOk
      ? await verifyProjectOnAisensyBusiness(storedBusinessId, storedProjectId)
      : false;
    if (businessOk && projectOk) {
      return partnerRow;
    }
  }

  const resolvedBusiness = await resolveAisensyBusinessId(user, partnerRow, {
    companyName: projectName,
    email: user.email,
    mobile: user.mobileNumber,
    allowSharedBusiness: !!(partnerRow?.business_id && partnerRow?.external_project_id),
  });

  let aisensyProjectId = partnerRow?.external_project_id
    ? String(partnerRow.external_project_id).trim()
    : '';
  if (!aisensyProjectId) {
    try {
      const created = await createProject(resolvedBusiness.id, user, {
        companyName: projectName,
        projectName,
      });
      aisensyProjectId = String(created.projectId || '').trim();
    } catch (error) {
      if (partnerRow?.external_project_id) {
        aisensyProjectId = String(partnerRow.external_project_id).trim();
      } else {
        throw error;
      }
    }
  }

  partnerRow = await savePartnerBusinessForProject({
    user,
    localProjectId,
    aisensyBusinessId: resolvedBusiness.id,
    aisensyProjectId,
    plainPassword: resolvedBusiness.password,
    projectName,
  });
  return partnerRow;
}

async function findSourceConnectedAccount(userId, excludeProjectId) {
  const accounts = await WhatsAppAccount.findAll({
    where: { client_id: userId },
    order: [['id', 'DESC']],
  });
  return (
    accounts.find((row) => {
      if (Number(row.projectId) === Number(excludeProjectId)) return false;
      return isFullyLinkedAccount(row);
    }) || null
  );
}

/**
 * After a new local project is created:
 * - Create AiSensy partner_businesses mapping + external project id
 * - User connects WhatsApp via Embedded Signup (no auto-clone from other projects)
 */
async function bootstrapNewProjectWhatsApp(userId, localProjectId, projectName) {
  const uid = Number(userId);
  const pid = Number(localProjectId);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return { connected: false, reason: 'invalid_ids' };
  }

  const user = await User.findByPk(uid);
  if (!user) {
    return { connected: false, reason: 'user_not_found' };
  }

  const existingForProject = await WhatsAppAccount.findOne({
    where: { client_id: uid, projectId: pid },
    order: [['id', 'DESC']],
  });
  if (isFullyLinkedAccount(existingForProject)) {
    return { connected: true, action: 'already_connected', localProjectId: pid };
  }

  let partnerRow;
  try {
    partnerRow = await ensureAisensyPartnerRow(user, pid, projectName);
  } catch (error) {
    console.warn('[newProjectWhatsApp] partner bootstrap failed:', error?.message || error);
    return {
      connected: false,
      requiresWhatsAppConnect: true,
      action: 'partner_bootstrap_failed',
      message: error?.message || 'Failed to prepare AiSensy project mapping',
      localProjectId: pid,
    };
  }

  // New projects must connect via Embedded Signup — do not clone WABA from another project.
  return {
    connected: false,
    requiresWhatsAppConnect: true,
    action: 'needs_embedded_signup',
    localProjectId: pid,
    partnerProjectId: partnerRow?.external_project_id || null,
    message: 'Project created. Connect WhatsApp for this project to send templates.',
  };
}

/**
 * Link onboarded WABA to this project's AiSensy assistant (required for Direct API sends).
 */
async function linkWabaToAisensyProject(partnerRow, waAccount, opts = {}) {
  const localAssistantId = String(partnerRow?.external_project_id || '').trim();
  const wabaAppId = String(waAccount?.waba_id || '').trim();
  const accessToken = String(
    opts.accessToken || waAccount?.access_token || ''
  ).trim();
  if (!localAssistantId || !wabaAppId) {
    return { ok: false, reason: 'missing_assistant_or_waba' };
  }

  const assistantIds = new Set([localAssistantId]);
  if (opts.canonicalAssistantId && String(opts.canonicalAssistantId).trim()) {
    assistantIds.add(String(opts.canonicalAssistantId).trim());
  }

  let lastOk = null;
  let lastFail = null;
  for (const assistantId of assistantIds) {
    try {
      const res = await submitFacebookAccessToken({
        assistantId,
        wabaAppId,
        accessToken,
      });
      lastOk = { ok: true, status: res?.status, assistantId, wabaAppId, canonical: assistantId !== localAssistantId };
    } catch (error) {
      lastFail = error;
      console.warn(
        `[ensureProjectMessaging] submitFacebookAccessToken (${assistantId}):`,
        error?.message || error
      );
    }
  }

  if (lastOk?.ok) return lastOk;
  return {
    ok: false,
    reason: lastFail?.message || 'submit_failed',
    assistantId: localAssistantId,
    wabaAppId,
  };
}

/**
 * Before sending: ensure partner_businesses row + Direct API JWT exist for this project.
 * Clones WABA from another connected project when needed (same as create-project bootstrap).
 * Always re-submits WABA to AiSensy + subscribes Meta app (fixes Graph/Direct API error #10).
 */
async function ensureProjectMessagingCredentials(userId, localProjectId, projectName = null) {
  const uid = Number(userId);
  const pid = Number(localProjectId);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid_ids' };
  }

  const {
    findPartnerBusinessByProject,
    getStoredDirectApiJwt,
  } = require('./partnerBusinessService');
  const { findScopedWhatsAppAccount } = require('../utils/whatsappPayment');
  const { ensureAppSubscribedToWaba } = require('./meta.service');

  let partnerRow = await findPartnerBusinessByProject(pid);
  let storedJwt = partnerRow ? await getStoredDirectApiJwt(pid) : null;
  const hasExternal = Boolean(String(partnerRow?.external_project_id || '').trim());
  const hasJwt = Boolean(String(storedJwt?.token || '').trim());

  let waAccount = await findScopedWhatsAppAccount(uid, pid);
  const hasWa = Boolean(
    waAccount &&
      String(waAccount.waba_id || '').trim() &&
      String(waAccount.phone_number_id || '').trim() &&
      String(waAccount.access_token || '').trim()
  );

  if (!hasWa) {
    const source = await findSourceConnectedAccount(uid, pid);
    if (!source) {
      return { ok: false, reason: 'needs_whatsapp_connect', connected: false };
    }
  }

  if (!hasExternal || !hasJwt || !hasWa) {
    let name = projectName;
    if (!name) {
      try {
        const Project = require('../models/Project');
        const project = await Project.findById(pid);
        name = project?.project_name || 'Project';
      } catch (_) {
        name = 'Project';
      }
    }
    await bootstrapNewProjectWhatsApp(uid, pid, name);
    partnerRow = await findPartnerBusinessByProject(pid);
    waAccount = await findScopedWhatsAppAccount(uid, pid);
    storedJwt = partnerRow ? await getStoredDirectApiJwt(pid) : null;
  }

  waAccount = waAccount || (await findScopedWhatsAppAccount(uid, pid));
  partnerRow = partnerRow || (await findPartnerBusinessByProject(pid));

  let aisensyLink = { ok: false, skipped: true };
  if (partnerRow && waAccount) {
    let canonicalAssistantId = null;
    try {
      const { resolveCanonicalAisensyAssistantId } = require('./partnerBusinessService');
      canonicalAssistantId = await resolveCanonicalAisensyAssistantId(uid, pid);
    } catch (_) {
      /* non-fatal */
    }

    aisensyLink = await linkWabaToAisensyProject(partnerRow, waAccount, {
      accessToken: waAccount.access_token,
      canonicalAssistantId,
    });

    const wabaId = String(waAccount.waba_id || '').trim();
    const accessToken = String(waAccount.access_token || '').trim();
    if (wabaId && accessToken) {
      try {
        await ensureAppSubscribedToWaba(wabaId, accessToken);
      } catch (subErr) {
        console.warn('[ensureProjectMessaging] ensureAppSubscribedToWaba:', subErr?.message || subErr);
      }
    }

    storedJwt = partnerRow ? await getStoredDirectApiJwt(pid) : null;
    const jwtMissing = !String(storedJwt?.token || '').trim();
    if (jwtMissing || aisensyLink.ok) {
      try {
        const credentialParts = await resolveCredentialParts({ localProjectId: pid });
        await regenerateTokenDirectApi({ credentialParts });
      } catch (regenErr) {
        console.warn('[ensureProjectMessaging] JWT regenerate:', regenErr?.message || regenErr);
      }
    }
  }

  waAccount = await findScopedWhatsAppAccount(uid, pid);
  const connected = Boolean(
    waAccount &&
      String(waAccount.waba_id || '').trim() &&
      String(waAccount.phone_number_id || '').trim() &&
      String(waAccount.access_token || '').trim()
  );

  try {
    const { refreshProjectWhatsAppAccessToken } = require('../utils/metaWhatsAppCredentials');
    await refreshProjectWhatsAppAccessToken(uid, pid);
    waAccount = await findScopedWhatsAppAccount(uid, pid);
  } catch (_) {
    /* non-fatal */
  }

  return {
    ok: connected,
    connected,
    aisensyLink,
    externalProjectId: partnerRow?.external_project_id || null,
    wabaId: waAccount?.waba_id || null,
    phoneNumberId: waAccount?.phone_number_id || null,
  };
}

module.exports = {
  bootstrapNewProjectWhatsApp,
  ensureAisensyPartnerRow,
  ensureProjectMessagingCredentials,
  linkWabaToAisensyProject,
};
