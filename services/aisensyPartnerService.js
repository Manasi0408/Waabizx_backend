/**
 * AiSensy Partner API helpers for WhatsApp onboarding:
 * 1) Create Business
 * 2) Create Project under that business
 */
const crypto = require('crypto');
const {
  createBusinessExternal,
  getBusinessExternal,
  listBusinessesExternal,
  getPartnerId,
  getPartnerApiBase,
  aisensyPartnerRequest,
} = require('./aisensyPartnerApiClient');
const { logPartnerApi } = require('../utils/partnerApiLogger');

function pickId(...candidates) {
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }
  return null;
}

function normalizeContact(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '').trim();
  return digits.length >= 10 ? digits : '919999999999';
}

/**
 * POST /partner/{partnerId}/business
 * Always logs REQUEST / PAYLOAD / RESPONSE as AISENSY_PARTNER_POST_BUSINESS
 * @returns {{ id: string, password: string, raw: object }}
 */
async function createBusiness(customer, opts = {}) {
  const displayName = String(
    opts.companyName || customer?.name || customer?.email || 'Waabizx Customer'
  ).trim();
  const email = String(opts.email || customer?.email || '')
    .trim()
    .toLowerCase();
  if (!email) {
    const err = new Error('email is required to create AiSensy business');
    err.statusCode = 400;
    throw err;
  }

  const password =
    String(opts.password || '').trim() ||
    `Wx${crypto.randomBytes(8).toString('base64url')}!a1`;

  const body = {
    display_name: displayName,
    email,
    password,
    company: String(opts.companyName || displayName).trim(),
    contact: normalizeContact(opts.mobile || customer?.mobileNumber),
    currency: 'INR',
    timezone: 'Asia/Calcutta GMT+05:30',
  };

  const pid = getPartnerId();
  const path = `/partner/${encodeURIComponent(pid)}/business`;
  const url = `${getPartnerApiBase()}${path}`;
  const requestMeta = {
    method: 'POST',
    url,
    partnerId: pid,
    base: getPartnerApiBase(),
    path,
  };
  // Never log raw password in partner-api.log
  const logBody = { ...body, password: '***' };

  // Force visible log lines in partner-api.log (search: AISENSY_PARTNER_POST_BUSINESS)
  logPartnerApi('AISENSY_PARTNER_POST_BUSINESS', requestMeta, logBody, {
    status: 'calling',
    note: 'About to call AiSensy create business API',
  });

  try {
    const res = await createBusinessExternal(body);
    const data = res?.data || {};
    const nested = data.data && typeof data.data === 'object' ? data.data : {};
    const id = pickId(
      data.id,
      data.business_id,
      nested.id,
      nested.business_id
    );

    logPartnerApi('AISENSY_PARTNER_POST_BUSINESS', requestMeta, logBody, {
      status: res?.status || 200,
      businessId: id || null,
      data,
      note: id
        ? 'Create business OK — search AISENSY_PARTNER_POST_BUSINESS'
        : 'Create business returned no businessId',
    });

    if (!id) {
      const err = new Error(
        'AiSensy create business succeeded but no business id was returned'
      );
      err.statusCode = 502;
      err.response = { data };
      throw err;
    }

    return { id, password, raw: data, payload: body };
  } catch (error) {
    logPartnerApi('AISENSY_PARTNER_POST_BUSINESS', requestMeta, logBody, {
      status: error.statusCode || 500,
      success: false,
      message: error.message,
      details: error.response?.data || null,
      note: 'Create business FAILED — search AISENSY_PARTNER_POST_BUSINESS',
    });
    throw error;
  }
}

/**
 * POST /partner/{partnerId}/business/{businessId}/project
 * Always logs REQUEST / PAYLOAD / RESPONSE as AISENSY_PARTNER_POST_PROJECT
 * @returns {{ projectId: string, raw: object }}
 */
async function createProject(businessId, customer, opts = {}) {
  const bid = String(businessId || '').trim();
  if (!bid) {
    const err = new Error('business_id is required to create AiSensy project');
    err.statusCode = 400;
    throw err;
  }

  const projectName = String(
    opts.projectName ||
      opts.companyName ||
      customer?.name ||
      customer?.email ||
      'Waabizx Project'
  ).trim();

  // AiSensy accepts `name` on some accounts; send both for compatibility.
  const body = {
    name: projectName,
    project_name: projectName,
    display_name: projectName,
  };

  const pid = getPartnerId();
  const path = `/partner/${encodeURIComponent(pid)}/business/${encodeURIComponent(bid)}/project`;
  const url = `${getPartnerApiBase()}${path}`;
  const requestMeta = {
    method: 'POST',
    url,
    partnerId: pid,
    base: getPartnerApiBase(),
    path,
  };

  // Force visible log lines in partner-api.log (search: AISENSY_PARTNER_POST_PROJECT)
  logPartnerApi('AISENSY_PARTNER_POST_PROJECT', requestMeta, body, {
    status: 'calling',
    note: 'About to call AiSensy create project API',
  });

  try {
    const res = await aisensyPartnerRequest(
      'AISENSY_PARTNER_POST_PROJECT',
      'POST',
      path,
      body
    );

    const data = res?.data || {};
    const nested = data.data && typeof data.data === 'object' ? data.data : {};
    const projectId = pickId(
      data.projectId,
      data.project_id,
      data.id,
      nested.projectId,
      nested.project_id,
      nested.id,
      Array.isArray(data.project_ids) ? data.project_ids[0] : null,
      Array.isArray(nested.project_ids) ? nested.project_ids[0] : null
    );

    logPartnerApi('AISENSY_PARTNER_POST_PROJECT', requestMeta, body, {
      status: res?.status || 200,
      projectId: projectId || null,
      data,
      note: projectId
        ? 'Create project OK — search AISENSY_PARTNER_POST_PROJECT'
        : 'Create project returned no projectId',
    });

    if (!projectId) {
      const err = new Error(
        'AiSensy create project succeeded but no projectId was returned'
      );
      err.statusCode = 502;
      err.response = { data };
      throw err;
    }

    return { projectId, raw: data, payload: body };
  } catch (error) {
    logPartnerApi('AISENSY_PARTNER_POST_PROJECT', requestMeta, body, {
      status: error.statusCode || 500,
      success: false,
      message: error.message,
      details: error.response?.data || null,
      note: 'Create project FAILED — search AISENSY_PARTNER_POST_PROJECT',
    });
    throw error;
  }
}

/**
 * POST /partner/{partnerId}/submit-facebook-access-token
 * Body (exact AiSensy contract): { assistantId, wabaAppId }
 * — assistantId = AiSensy project id, wabaAppId = WhatsApp Business Account id.
 */
async function submitFacebookAccessToken({ assistantId, wabaAppId, accessToken, facebookAccessToken } = {}) {
  const aid = String(assistantId || '').trim();
  const waba = String(wabaAppId || '').trim();
  const fbToken = String(accessToken || facebookAccessToken || '').trim();
  if (!aid) {
    const err = new Error('assistantId (AiSensy project id) is required for submit-facebook-access-token');
    err.statusCode = 400;
    throw err;
  }
  if (!waba) {
    const err = new Error('wabaAppId is required for submit-facebook-access-token');
    err.statusCode = 400;
    throw err;
  }

  const body = {
    assistantId: aid,
    wabaAppId: waba,
  };
  if (fbToken) {
    body.accessToken = fbToken;
    body.facebookAccessToken = fbToken;
  }

  const pid = getPartnerId();
  const path = `/partner/${encodeURIComponent(pid)}/submit-facebook-access-token`;
  const url = `${getPartnerApiBase()}${path}`;
  const requestMeta = {
    method: 'POST',
    url,
    partnerId: pid,
    base: getPartnerApiBase(),
    path,
  };
  const logBody = {
    assistantId: aid,
    wabaAppId: waba,
    accessToken: fbToken ? '***' : undefined,
  };

  logPartnerApi('AISENSY_PARTNER_SUBMIT_FB_TOKEN', requestMeta, logBody, {
    status: 'calling',
    note: 'About to call AiSensy submit-facebook-access-token',
  });

  try {
    const res = await aisensyPartnerRequest(
      'AISENSY_PARTNER_SUBMIT_FB_TOKEN',
      'POST',
      path,
      body
    );
    const data = res?.data || {};
    logPartnerApi('AISENSY_PARTNER_SUBMIT_FB_TOKEN', requestMeta, logBody, {
      status: res?.status || 200,
      data,
      note: 'submit-facebook-access-token OK',
    });
    return { ok: true, status: res?.status || 200, data, payload: body };
  } catch (error) {
    logPartnerApi('AISENSY_PARTNER_SUBMIT_FB_TOKEN', requestMeta, logBody, {
      status: error.statusCode || 500,
      success: false,
      message: error.message,
      details: error.response?.data || null,
      note: 'submit-facebook-access-token FAILED',
    });
    throw error;
  }
}

function pickBusinessIdFromResponse(data) {
  const nested = data?.data && typeof data.data === 'object' ? data.data : {};
  return pickId(data?.id, data?.business_id, nested.id, nested.business_id);
}

/** GET partner business — returns true only when AiSensy recognizes the id */
async function verifyBusinessOnAisensy(businessId) {
  const bid = String(businessId || '').trim();
  if (!bid) return false;
  try {
    const res = await getBusinessExternal(bid);
    return res?.status === 200 && !!pickBusinessIdFromResponse(res.data);
  } catch (_) {
    return false;
  }
}

function collectProjectIdsFromBusinessPayload(data) {
  const nested = data?.data && typeof data.data === 'object' ? data.data : {};
  const rows = [
    ...(Array.isArray(data?.project_ids) ? data.project_ids : []),
    ...(Array.isArray(data?.projectIds) ? data.projectIds : []),
    ...(Array.isArray(nested?.project_ids) ? nested.project_ids : []),
    ...(Array.isArray(nested?.projectIds) ? nested.projectIds : []),
  ];
  return rows.map((id) => String(id || '').trim()).filter(Boolean);
}

/** True when assistantId is listed on the AiSensy business (GET partner business). */
async function verifyProjectOnAisensyBusiness(businessId, projectId) {
  const bid = String(businessId || '').trim();
  const pid = String(projectId || '').trim();
  if (!bid || !pid) return false;
  try {
    const res = await getBusinessExternal(bid);
    const ids = collectProjectIdsFromBusinessPayload(res?.data || {});
    if (ids.length === 0) return true;
    return ids.includes(pid);
  } catch (_) {
    return false;
  }
}

/** Find AiSensy business id by owner email from partner business list */
async function findAisensyBusinessIdByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  try {
    const res = await listBusinessesExternal();
    const rows = Array.isArray(res?.data) ? res.data : [];
    const match = rows.find((row) => {
      const rowEmail = String(row?.email || row?.user_name || '')
        .trim()
        .toLowerCase();
      return rowEmail === normalized;
    });
    return pickId(match?.id, match?.business_id);
  } catch (_) {
    return null;
  }
}

function buildUniqueOnboardingEmail(email, userId) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0) {
    return `waabizx-user-${userId}-${Date.now()}@onboarding.local`;
  }
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${local}+waabizx${userId}${Date.now()}@${domain}`;
}

/**
 * Resolve a business id that exists on AiSensy (never use local-only hex ids).
 *
 * Order:
 * 1) verify this local project's stored id
 * 2) if allowSharedBusiness: email lookup → env probe fallback
 * 3) create a new AiSensy business (required for each new local project in production)
 *
 * Shared probe/email reuse is disabled for new local projects because
 * partner_businesses.business_id is UNIQUE and causes "Validation error" on save.
 */
async function resolveAisensyBusinessId(customer, existing, opts = {}) {
  const storedId = String(existing?.business_id || '').trim();
  if (storedId && (await verifyBusinessOnAisensy(storedId))) {
    return {
      id: storedId,
      source: 'verified_db',
      reused: true,
    };
  }

  const email = String(opts.email || customer?.email || '')
    .trim()
    .toLowerCase();
  const allowShared = opts.allowSharedBusiness === true;

  if (allowShared) {
    const byEmail = await findAisensyBusinessIdByEmail(email);
    if (byEmail && (await verifyBusinessOnAisensy(byEmail))) {
      return {
        id: byEmail,
        source: 'aisensy_email_lookup',
        reused: true,
      };
    }

    const fallbackId = String(
      process.env.AISENSY_PARTNER_PROBE_BUSINESS_ID || ''
    ).trim();
    if (fallbackId && (await verifyBusinessOnAisensy(fallbackId))) {
      return {
        id: fallbackId,
        source: 'env_fallback',
        reused: true,
      };
    }
  }

  const createEmail = buildUniqueOnboardingEmail(email, customer?.id);
  const business = await createBusiness(customer, {
    ...opts,
    email: createEmail,
  });

  return {
    id: business.id,
    source: 'aisensy_create',
    reused: false,
    password: business.password,
    raw: business.raw,
    createEmail,
  };
}

module.exports = {
  createBusiness,
  createProject,
  submitFacebookAccessToken,
  verifyBusinessOnAisensy,
  verifyProjectOnAisensyBusiness,
  findAisensyBusinessIdByEmail,
  resolveAisensyBusinessId,
};
