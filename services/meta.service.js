const axios = require('axios');
const { Op } = require('sequelize');
const { Client, WhatsAppAccount, User, ClientWhatsApp, PartnerBusiness } = require('../models');
const db = require('../config/db');
const {
  logEmbeddedSignupApi,
  loggedGraphRequest,
} = require('../utils/embeddedSignupLogger');

const APP_ID = process.env.APP_ID || process.env.META_APP_ID;
const APP_SECRET =
  process.env.APP_SECRET || process.env.META_APP_SECRET || process.env.META_APPSECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || process.env.META_REDIRECT_URI;
const API_VERSION = process.env.META_GRAPH_API_VERSION || process.env.GRAPH_API_VERSION || 'v23.0';
const META_CONFIG_ID = process.env.META_CONFIG_ID || process.env.REACT_APP_META_CONFIG_ID || '';
const EMBEDDED_SIGNUP_SCOPES = String(
  process.env.META_EMBEDDED_SIGNUP_SCOPES ||
    'business_management,whatsapp_business_management,whatsapp_business_messaging'
).trim();

const graphBase = () => `https://graph.facebook.com/${API_VERSION}`;

let cachedSolutionId = null;
let cachedSolutionAt = 0;

function readMetaSystemToken() {
  return String(
    process.env.META_SYSTEM_USER_TOKEN ||
      process.env.AISENSY_META_SYSTEM_TOKEN ||
      process.env.WHATSAPP_TOKEN ||
      ''
  ).trim();
}

/**
 * Path A (locked): AiSensy multi-partner Solution Partner billing.
 * Always pass extras.setup.solutionID — never omit it to show Meta's own card UI (Path B).
 * Clients share AiSensy's credit line; Tech Provider must not expect customer cards on WABA Summary
 * until credit sharing succeeds (AiSensy attach and/or Tech Provider Reseller ToS).
 */
function buildEmbeddedSignupExtras(solutionId) {
  const sid = String(solutionId || '').trim();
  if (!sid) {
    throw new Error(
      'Path A requires META_SOLUTION_ID (AiSensy partner solution). Set META_SOLUTION_ID in backend .env.'
    );
  }
  return {
    setup: { solutionID: sid },
    featureType: '',
    sessionInfoVersion: '3',
  };
}

/** Active multi-partner solution ID (AiSensy SP) — required for Path A partner billing. */
async function resolveMetaSolutionId() {
  const fromEnv = String(
    process.env.META_SOLUTION_ID ||
      process.env.REACT_APP_META_SOLUTION_ID ||
      process.env.REACT_APP_AISENSY_SOLUTION_ID ||
      ''
  ).trim();
  if (fromEnv) return fromEnv;

  if (cachedSolutionId && Date.now() - cachedSolutionAt < 5 * 60 * 1000) {
    return cachedSolutionId;
  }

  const appId = String(APP_ID || '').trim();
  const token = readMetaSystemToken();
  if (!appId || !token) return null;

  try {
    const res = await loggedGraphRequest('ES_GRAPH_WHATSAPP_BUSINESS_SOLUTIONS', {
      method: 'get',
      url: `${graphBase()}/${encodeURIComponent(appId)}/whatsapp_business_solutions`,
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'id,name,status' },
    });
    const solutions = Array.isArray(res.data?.data) ? res.data.data : [];
    const active =
      solutions.find((row) => String(row?.status || '').toUpperCase() === 'ACTIVE') || solutions[0];
    const sid = active?.id != null ? String(active.id).trim() : '';
    if (sid) {
      cachedSolutionId = sid;
      cachedSolutionAt = Date.now();
      return sid;
    }
  } catch (_) {
    /* non-fatal */
  }
  return null;
}

function encodeReturnOrigin(origin) {
  const o = String(origin || '').trim();
  if (!o || !/^https?:\/\//i.test(o)) return '';
  try {
    return `o${Buffer.from(o, 'utf8').toString('base64url')}`;
  } catch (_) {
    return '';
  }
}

function decodeReturnOriginSegment(segment) {
  const s = String(segment || '').trim();
  if (!s.startsWith('o') || s.length < 2) return null;
  try {
    const decoded = Buffer.from(s.slice(1), 'base64url').toString('utf8').trim();
    if (/^https?:\/\//i.test(decoded)) {
      return decoded.replace(/\/$/, '');
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

/** Parse OAuth state: `clientId`, optional `projectId`, optional `page`, optional encoded return origin. */
function parseOAuthState(stateRaw) {
  const parts = String(stateRaw || '').split(':');
  const clientId = parseInt(parts[0], 10);
  let projectId = null;
  let pageFlow = false;
  let returnOrigin = null;
  for (let i = 1; i < parts.length; i += 1) {
    const segment = String(parts[i] || '').trim();
    if (!segment) continue;
    if (segment === 'page') {
      pageFlow = true;
      continue;
    }
    const origin = decodeReturnOriginSegment(segment);
    if (origin) {
      returnOrigin = origin;
      continue;
    }
    const pid = parseInt(segment, 10);
    if (Number.isInteger(pid) && pid > 0) projectId = pid;
  }
  return {
    clientId: Number.isInteger(clientId) && clientId > 0 ? clientId : null,
    projectId,
    pageFlow,
    returnOrigin,
  };
}

function buildOAuthState(clientId, projectId = null, pageFlow = false, returnOrigin = null) {
  const cid = Number(clientId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error('client_id is required');
  }
  const pid = projectId != null ? Number(projectId) : null;
  let state = Number.isInteger(pid) && pid > 0 ? `${cid}:${pid}` : String(cid);
  if (pageFlow) state += ':page';
  const encodedOrigin = encodeReturnOrigin(returnOrigin);
  if (encodedOrigin) state += `:${encodedOrigin}`;
  return state;
}

// const DEFAULT_META_CALLBACK_URI = 'https://wabizx.techwhizzc.com/meta/callback';
const DEFAULT_META_CALLBACK_URI = 'https://api.waabizx.com/meta/callback';

/** Prefer configured production callback over stale ngrok URLs.
 *  Empty string is preserved (Embedded Signup / FB.login token exchange omits redirect_uri).
 */
function normalizeMetaOAuthRedirectUri(candidate) {
  if (candidate !== undefined && candidate !== null && String(candidate).trim() === '') {
    return '';
  }
  const configured = String(process.env.META_REDIRECT_URI || process.env.REDIRECT_URI || '').trim();
  const fallback =
    configured && !configured.includes('ngrok') ? configured : DEFAULT_META_CALLBACK_URI;
  const value = String(candidate || configured || fallback).trim();
  if (!value) return fallback;
  if (value.includes('ngrok')) {
    return fallback;
  }
  return value;
}

const PIN_RE = /^\d{6}$/;

/**
 * Validates Meta Cloud API two-step verification PIN (6 digits).
 */
function assertValidRegistrationPin(pin, label = 'pin') {
  const raw = pin != null ? String(pin).trim() : '';
  if (!PIN_RE.test(raw)) {
    const err = new Error(`${label} must be a 6-digit numeric two-step verification PIN`);
    err.statusCode = 400;
    throw err;
  }
  return raw;
}

/**
 * GET phone number fields from Graph (for Pending vs Connected / messaging readiness).
 */
async function fetchCloudApiPhoneRegistrationState(phoneNumberId, accessToken) {
  if (!phoneNumberId || !accessToken) {
    const err = new Error('phone_number_id and access token are required');
    err.statusCode = 400;
    throw err;
  }
  const fields = [
    'id',
    'display_phone_number',
    'verified_name',
    'code_verification_status',
    'quality_rating',
    'name_status',
    'throughput',
  ].join(',');
  const res = await axios.get(`${graphBase()}/${encodeURIComponent(phoneNumberId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { fields },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const msg = res.data?.error?.message || `Graph error (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.graph = res.data;
    throw err;
  }
  return res.data || {};
}

/**
 * POST /PHONE_NUMBER_ID/register — completes Cloud API registration (two-step verification PIN).
 */
async function registerWhatsAppPhoneForCloudApi(
  phoneNumberId,
  accessToken,
  pin,
  { dataLocalizationRegion = null } = {}
) {
  const normalizedPin = assertValidRegistrationPin(pin, 'pin');
  const body = {
    messaging_product: 'whatsapp',
    pin: normalizedPin,
  };
  const region = String(dataLocalizationRegion || process.env.META_WHATSAPP_DATA_LOCALIZATION_REGION || '').trim();
  if (region && /^[A-Z]{2}$/i.test(region)) {
    body.data_localization_region = region.toUpperCase();
  }
  const res = await loggedGraphRequest('ES_GRAPH_PHONE_REGISTER', {
    method: 'post',
    url: `${graphBase()}/${encodeURIComponent(phoneNumberId)}/register`,
    data: body,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status >= 400) {
    const msg = res.data?.error?.message || `Register failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.graph = res.data;
    throw err;
  }
  return res.data || { success: true };
}

/**
 * Request SMS/voice OTP for phone ownership (when Meta requires it before register).
 * @see Graph — phone number request_code
 */
async function requestWhatsAppPhoneVerificationCode(
  phoneNumberId,
  accessToken,
  { codeMethod = 'SMS', language = 'en_US' } = {}
) {
  if (!phoneNumberId || !accessToken) {
    const err = new Error('phone_number_id and access token are required');
    err.statusCode = 400;
    throw err;
  }
  const method = String(codeMethod || 'SMS').toUpperCase();
  const lang = String(language || 'en_US').trim() || 'en_US';
  const res = await axios.post(
    `${graphBase()}/${encodeURIComponent(phoneNumberId)}/request_code`,
    {},
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { code_method: method, language: lang },
      validateStatus: () => true,
    }
  );
  if (res.status >= 400) {
    const msg = res.data?.error?.message || `request_code failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.graph = res.data;
    throw err;
  }
  return res.data || { success: true };
}

async function verifyWhatsAppPhoneWithOtpCode(phoneNumberId, accessToken, code) {
  const raw = code != null ? String(code).trim() : '';
  if (!/^\d{4,8}$/.test(raw)) {
    const err = new Error('code must be a 4-8 digit OTP from Meta');
    err.statusCode = 400;
    throw err;
  }
  const res = await axios.post(
    `${graphBase()}/${encodeURIComponent(phoneNumberId)}/verify_code`,
    { code: raw },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );
  if (res.status >= 400) {
    const msg = res.data?.error?.message || `verify_code failed (${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.status;
    err.graph = res.data;
    throw err;
  }
  return res.data || { success: true };
}

/**
 * Returns a 6-digit two-step PIN from environment if configured (for automatic POST .../register).
 */
function readEnvRegistrationPin() {
  const raw = String(
    process.env.META_WHATSAPP_REGISTRATION_PIN ||
      process.env.META_CLOUD_API_REGISTRATION_PIN ||
      process.env.WHATSAPP_REGISTRATION_PIN ||
      process.env.WHATSAPP_TWO_STEP_PIN ||
      process.env.META_WHATSAPP_TWO_STEP_PIN ||
      ''
  ).trim();
  return PIN_RE.test(raw) ? raw : null;
}

async function tryRegisterPhoneAfterOnboarding(phoneNumberId, accessToken, registrationPinOverride) {
  if (!phoneNumberId || !accessToken) {
    return {
      attempted: false,
      success: false,
      reason: !phoneNumberId ? 'missing_phone_number_id' : 'missing_access_token',
    };
  }
  const fromEnv = readEnvRegistrationPin();
  const fromOverride =
    registrationPinOverride != null ? String(registrationPinOverride).trim() : null;
  const pin = PIN_RE.test(fromOverride || '')
    ? fromOverride
    : fromEnv
      ? fromEnv
      : null;
  if (!pin) {
    return { attempted: false, success: false, reason: 'no_valid_pin_configured' };
  }
  try {
    await registerWhatsAppPhoneForCloudApi(phoneNumberId, accessToken, pin);
    return { attempted: true, success: true, pinSource: PIN_RE.test(fromOverride || '') ? 'request' : 'env' };
  } catch (e) {
    return {
      attempted: true,
      success: false,
      pinSource: PIN_RE.test(fromOverride || '') ? 'request' : 'env',
      error: e?.response?.data?.error?.message || e.message,
      errorCode: e?.response?.data?.error?.code,
    };
  }
}

const logger = require('../utils/logger');
const { ensureWhatsAppAccountPaymentColumns } = require('../utils/ensureWhatsAppAccountSchema');

/** Debug onboarding without leaking full tokens (length only). */
function logOnboarding(step, details = {}) {
  logger.metaOnboarding(step, details);
}

function readMetaSystemTokenForSubscribe() {
  return String(
    process.env.META_SYSTEM_USER_TOKEN ||
      process.env.AISENSY_META_SYSTEM_TOKEN ||
      process.env.WHATSAPP_TOKEN ||
      ''
  ).trim();
}

/**
 * Subscribe this Meta app to the client's WABA (required for Cloud API messaging).
 * Without this, sends fail with Graph error #10 (insufficient permissions).
 */
async function ensureAppSubscribedToWaba(wabaId, accessToken) {
  const waba = String(wabaId || '').trim();
  const token = String(accessToken || '').trim();
  if (!waba || !token) {
    return { subscribed: false, reason: 'missing_waba_or_token' };
  }

  const attempt = async (tok, label) => {
    const res = await loggedGraphRequest('ES_GRAPH_WABA_SUBSCRIBED_APPS', {
      method: 'post',
      url: `${graphBase()}/${encodeURIComponent(waba)}/subscribed_apps`,
      data: {},
      headers: { Authorization: `Bearer ${tok}` },
    });
    const msg = String(res.data?.error?.message || res.data?.message || '').toLowerCase();
    const ok =
      res.status < 400 ||
      res.data?.success === true ||
      msg.includes('already') ||
      msg.includes('subscribed');
    logOnboarding('waba_subscribed_apps', {
      wabaId: waba,
      tokenSource: label,
      httpStatus: res.status,
      ok,
      graphMessage: res.data?.error?.message || res.data?.message || null,
    });
    return ok;
  };

  if (await attempt(token, 'user_token')) {
    return { subscribed: true };
  }

  const systemToken = readMetaSystemTokenForSubscribe();
  if (systemToken && systemToken !== token) {
    if (await attempt(systemToken, 'system_token')) {
      return { subscribed: true };
    }
  }

  return { subscribed: false, reason: 'subscribe_failed' };
}

/**
 * Path A: share + attach extended credit line to client WABA after Embedded Signup.
 * POST /{EXTENDED_CREDIT_LINE_ID}/whatsapp_credit_sharing_and_attach
 *
 * May fail with Graph (#10) until Techwhizzc accepts Business Messaging Tech Provider
 * Reseller / Credit Allocation terms, OR until AiSensy (SP) attaches their line.
 * Empty Meta Summary "Payment method" is expected until attach succeeds.
 */
async function attachExtendedCreditLineToWaba(wabaId, opts = {}) {
  const waba = String(wabaId || '').trim();
  const creditLineId = String(
    opts.creditLineId || process.env.META_EXTENDED_CREDIT_LINE_ID || ''
  ).trim();
  const currency = String(
    opts.currency || process.env.META_WABA_CURRENCY || 'INR'
  )
    .trim()
    .toUpperCase() || 'INR';
  const systemToken = String(
    opts.systemToken ||
      process.env.META_SYSTEM_USER_TOKEN ||
      process.env.AISENSY_META_SYSTEM_TOKEN ||
      ''
  ).trim();

  if (!waba) {
    return { attached: false, reason: 'missing_waba_id' };
  }
  if (!creditLineId) {
    return { attached: false, reason: 'META_EXTENDED_CREDIT_LINE_ID_not_set' };
  }
  if (!systemToken) {
    return { attached: false, reason: 'META_SYSTEM_USER_TOKEN_not_set' };
  }

  const url = `${graphBase()}/${encodeURIComponent(creditLineId)}/whatsapp_credit_sharing_and_attach`;
  try {
    const res = await loggedGraphRequest('ES_GRAPH_CREDIT_SHARING_AND_ATTACH', {
      method: 'post',
      url,
      data: null,
      params: { waba_id: waba, waba_currency: currency },
      headers: { Authorization: `Bearer ${systemToken}` },
      timeout: 30000,
    });

    const ok = res.status < 400 && (res.data?.waba_id || res.data?.allocation_config_id || res.data?.success);
    const already =
      /already|attached|exist/i.test(String(res.data?.error?.message || '')) ||
      /already|attached|exist/i.test(String(res.data?.message || ''));

    logOnboarding('waba_credit_line_attach', {
      wabaId: waba,
      creditLineId,
      currency,
      httpStatus: res.status,
      ok: Boolean(ok || already),
      allocationConfigId: res.data?.allocation_config_id || null,
      graphMessage: res.data?.error?.message || res.data?.message || null,
      data: res.data || null,
    });

    if (ok || already) {
      return {
        attached: true,
        alreadyAttached: Boolean(already),
        allocationConfigId: res.data?.allocation_config_id || null,
        raw: res.data,
      };
    }

    return {
      attached: false,
      reason: res.data?.error?.message || `credit_line_attach_failed_${res.status}`,
      httpStatus: res.status,
      raw: res.data,
    };
  } catch (e) {
    logOnboarding('waba_credit_line_attach_error', {
      wabaId: waba,
      creditLineId,
      error: e?.message || String(e),
    });
    return { attached: false, reason: e?.message || 'credit_line_attach_network_error' };
  }
}

/**
 * Meta no longer exposes whatsapp_business_accounts on User /me for many apps.
 * Resolve WABA via assigned_whatsapp_business_accounts, then Business-owned WABAs, then legacy field.
 */
async function resolveWabaAndPhoneFromToken(longToken) {
  const headers = { Authorization: `Bearer ${longToken}` };
  const base = graphBase();

  let wabaId = null;
  let phoneNumberId = null;
  let businessId = null;

  const fetchPhoneForWaba = async (id) => {
    const phoneRes = await loggedGraphRequest('ES_GRAPH_WABA_PHONE_NUMBERS', {
      method: 'get',
      url: `${base}/${id}/phone_numbers`,
      headers,
    });
    if (phoneRes.status >= 400) {
      const err = new Error(phoneRes.data?.error?.message || `phone_numbers failed (${phoneRes.status})`);
      err.response = { status: phoneRes.status, data: phoneRes.data };
      throw err;
    }
    const phoneData = phoneRes.data?.data;
    if (!phoneData || phoneData.length === 0) {
      throw new Error('No phone number found for WABA');
    }
    return phoneData[0].id;
  };

  // 1) Assigned WABAs (documented User edge — replaces me?fields=whatsapp_business_accounts)
  try {
    const assignedRes = await loggedGraphRequest('ES_GRAPH_ME_ASSIGNED_WABAS', {
      method: 'get',
      url: `${base}/me/assigned_whatsapp_business_accounts`,
      headers,
      params: { fields: 'id,name,phone_numbers{id}' },
    });
    if (assignedRes.status >= 400) {
      const code = assignedRes.data?.error?.code;
      if (code === 190 || code === 102) {
        const err = new Error(assignedRes.data?.error?.message || 'token error');
        err.response = { status: assignedRes.status, data: assignedRes.data };
        throw err;
      }
    } else {
      const assigned = assignedRes.data?.data;
      if (assigned?.length) {
        wabaId = assigned[0].id;
        phoneNumberId = assigned[0]?.phone_numbers?.data?.[0]?.id || null;
      }
    }
  } catch (e) {
    const code = e?.response?.data?.error?.code;
    if (code === 190 || code === 102) throw e;
  }

  // 2a) Businesses you manage → owned WABAs
  if (!wabaId) {
    try {
      const bizRes = await loggedGraphRequest('ES_GRAPH_ME_OWNED_WABAS', {
        method: 'get',
        url: `${base}/me`,
        headers,
        params: { fields: 'businesses{owned_whatsapp_business_accounts{id}}' },
      });
      if (bizRes.status >= 400) {
        const code = bizRes.data?.error?.code;
        if (code === 190 || code === 102) {
          const err = new Error(bizRes.data?.error?.message || 'token error');
          err.response = { status: bizRes.status, data: bizRes.data };
          throw err;
        }
      } else {
        const businesses = bizRes.data?.businesses?.data || [];
        for (const b of businesses) {
          const owned = b?.owned_whatsapp_business_accounts?.data;
          if (owned?.length) {
            wabaId = owned[0].id;
            businessId = String(b.id || '').trim() || businessId;
            break;
          }
        }
      }
    } catch (e) {
      const code = e?.response?.data?.error?.code;
      if (code === 190 || code === 102) throw e;
    }
  }

  // 2b) Solution-provider / client WABAs on Business
  if (!wabaId) {
    try {
      const bizRes = await loggedGraphRequest('ES_GRAPH_ME_CLIENT_WABAS', {
        method: 'get',
        url: `${base}/me`,
        headers,
        params: { fields: 'businesses{client_whatsapp_business_accounts{id}}' },
      });
      if (bizRes.status >= 400) {
        const code = bizRes.data?.error?.code;
        if (code === 190 || code === 102) {
          const err = new Error(bizRes.data?.error?.message || 'token error');
          err.response = { status: bizRes.status, data: bizRes.data };
          throw err;
        }
      } else {
        const businesses = bizRes.data?.businesses?.data || [];
        for (const b of businesses) {
          const client = b?.client_whatsapp_business_accounts?.data;
          if (client?.length) {
            wabaId = client[0].id;
            businessId = String(b.id || '').trim() || businessId;
            break;
          }
        }
      }
    } catch (e) {
      const code = e?.response?.data?.error?.code;
      if (code === 190 || code === 102) throw e;
    }
  }

  // 3) Legacy User field (older Graph behavior)
  if (!wabaId) {
    try {
      const legacyRes = await loggedGraphRequest('ES_GRAPH_ME_LEGACY_WABAS', {
        method: 'get',
        url: `${base}/me`,
        headers,
        params: { fields: 'whatsapp_business_accounts{id}' },
      });
      if (legacyRes.status >= 400) {
        const code = legacyRes.data?.error?.code;
        if (code === 190 || code === 102) {
          const err = new Error(legacyRes.data?.error?.message || 'token error');
          err.response = { status: legacyRes.status, data: legacyRes.data };
          throw err;
        }
      } else {
        const legacy = legacyRes.data?.whatsapp_business_accounts?.data;
        if (legacy?.length) {
          wabaId = legacy[0].id;
        }
      }
    } catch (e) {
      const code = e?.response?.data?.error?.code;
      if (code === 190 || code === 102) throw e;
    }
  }

  if (!wabaId) {
    throw new Error(
      'No WhatsApp Business Account found for this login. Finish Embedded Signup in Meta, ' +
        'and ensure the app requests whatsapp_business_management (and business_management if needed).'
    );
  }

  if (!phoneNumberId) {
    phoneNumberId = await fetchPhoneForWaba(wabaId);
  }

  if (!businessId && wabaId) {
    try {
      const wabaRes = await loggedGraphRequest('ES_GRAPH_WABA_OWNER_BUSINESS', {
        method: 'get',
        url: `${base}/${wabaId}`,
        headers,
        params: { fields: 'owner_business_info' },
      });
      if (wabaRes.status < 400) {
        businessId =
          String(wabaRes.data?.owner_business_info?.id || '').trim() || businessId;
      }
    } catch (_) {
      /* non-fatal */
    }
  }

  return { wabaId, phoneNumberId, businessId: businessId || null };
}

async function findWhatsAppAccountRow(clientId, selectedProjectId) {
  await ensureWhatsAppAccountPaymentColumns();
  const cid = Number(clientId);
  const baseAttrs = [
    'id',
    'client_id',
    'projectId',
    'waba_id',
    'phone_number_id',
    'display_phone',
    'access_token',
    'token_expiry',
    'status',
    'aisensy_solution_id',
    'business_id',
    'account_status',
    'created_at',
  ];
  if (selectedProjectId != null && Number(selectedProjectId) > 0) {
    return WhatsAppAccount.findOne({
      where: { client_id: cid, projectId: Number(selectedProjectId) },
      attributes: baseAttrs,
      order: [['id', 'DESC']],
    });
  }
  // No project scope: latest account for this client (legacy / global checks only).
  return WhatsAppAccount.findOne({
    where: { client_id: cid },
    attributes: baseAttrs,
    order: [['id', 'DESC']],
  });
}

/**
 * Build Meta Embedded Signup OAuth URL — Path A only (AiSensy solutionID required).
 */
function buildEmbeddedSignupOAuthUrl({
  clientId,
  projectId = null,
  redirectUri,
  pageFlow = false,
  solutionId = null,
  returnOrigin = null,
}) {
  if (!APP_ID) {
    throw new Error('APP_ID / META_APP_ID is not set');
  }
  const configId = String(META_CONFIG_ID || '').trim();
  if (!configId) {
    throw new Error('META_CONFIG_ID is not set');
  }
  const sid = String(solutionId || '').trim();
  if (!sid) {
    throw new Error(
      'Path A (AiSensy partner billing) requires solutionId. Set META_SOLUTION_ID=1949725842387631'
    );
  }
  const redirect = normalizeMetaOAuthRedirectUri(redirectUri || REDIRECT_URI || '');
  if (!redirect) {
    throw new Error('META_REDIRECT_URI is not set');
  }
  if (/\/meta\/connect\/?$/i.test(redirect)) {
    throw new Error(
      'OAuth redirect_uri must be /meta/callback, not /meta/connect. Set META_REDIRECT_URI=https://your-domain/meta/callback'
    );
  }
  const state = buildOAuthState(clientId, projectId, pageFlow, returnOrigin);
  const params = new URLSearchParams({
    client_id: String(APP_ID),
    redirect_uri: redirect,
    state,
    config_id: configId,
    response_type: 'code',
    override_default_response_type: 'true',
  });
  if (EMBEDDED_SIGNUP_SCOPES) {
    params.set('scope', EMBEDDED_SIGNUP_SCOPES);
  }
  const extras = buildEmbeddedSignupExtras(sid);
  params.set('extras', JSON.stringify(extras));
  const url = `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params.toString()}`;
  logEmbeddedSignupApi(
    'ES_BUILD_OAUTH_URL',
    {
      method: 'GET',
      url: `https://www.facebook.com/${API_VERSION}/dialog/oauth`,
    },
    {
      billingPath: 'A_aisensy_partner',
      client_id: String(APP_ID),
      redirect_uri: redirect,
      state,
      config_id: configId,
      response_type: 'code',
      override_default_response_type: 'true',
      scope: EMBEDDED_SIGNUP_SCOPES || null,
      extras,
      clientId,
      projectId,
      pageFlow,
      returnOrigin: returnOrigin || null,
    },
    { signupUrl: url }
  );
  return url;
}

exports.buildEmbeddedSignupOAuthUrl = buildEmbeddedSignupOAuthUrl;
exports.normalizeMetaOAuthRedirectUri = normalizeMetaOAuthRedirectUri;
exports.buildEmbeddedSignupExtras = buildEmbeddedSignupExtras;
exports.resolveMetaSolutionId = resolveMetaSolutionId;
exports.parseOAuthState = parseOAuthState;
exports.buildOAuthState = buildOAuthState;
exports.tryRegisterPhoneAfterOnboarding = tryRegisterPhoneAfterOnboarding;
exports.readEnvRegistrationPin = readEnvRegistrationPin;
exports.resolveWabaAndPhoneFromToken = resolveWabaAndPhoneFromToken;
exports.ensureAppSubscribedToWaba = ensureAppSubscribedToWaba;
exports.attachExtendedCreditLineToWaba = attachExtendedCreditLineToWaba;
exports.fetchCloudApiPhoneRegistrationState = fetchCloudApiPhoneRegistrationState;
exports.registerWhatsAppPhoneForCloudApi = registerWhatsAppPhoneForCloudApi;
exports.requestWhatsAppPhoneVerificationCode = requestWhatsAppPhoneVerificationCode;
exports.verifyWhatsAppPhoneWithOtpCode = verifyWhatsAppPhoneWithOtpCode;

exports.completeOnboarding = async (
  code,
  clientId,
  selectedProjectId = null,
  redirectUriOverride = null,
  registrationPinOverride = null
) => {
  if (!APP_ID || !APP_SECRET) {
    throw new Error('APP_ID and APP_SECRET must be set');
  }

  const hasRedirectOverride =
    redirectUriOverride !== undefined && redirectUriOverride !== null;
  // FB.login Embedded Signup sends redirect_uri: "" — must OMIT redirect_uri on token
  // exchange. Do NOT normalize "" into META_REDIRECT_URI (that causes:
  // "redirect_uri is identical to the one you used in the OAuth dialog").
  const rawRedirectOverride = hasRedirectOverride
    ? String(redirectUriOverride).trim()
    : null;
  const omitRedirectUri = hasRedirectOverride && rawRedirectOverride === '';
  const effectiveRedirectUri = omitRedirectUri
    ? ''
    : normalizeMetaOAuthRedirectUri(
        hasRedirectOverride ? rawRedirectOverride : REDIRECT_URI || ''
      );
  if (!omitRedirectUri && !effectiveRedirectUri) {
    throw new Error('REDIRECT_URI is not set');
  }

  // 1) Exchange code for short-lived token
  logOnboarding('start', {
    clientId: clientId != null ? Number(clientId) : null,
    selectedProjectId:
      selectedProjectId != null && Number(selectedProjectId) > 0
        ? Number(selectedProjectId)
        : null,
    redirectUriHost: omitRedirectUri
      ? '(embedded signup — no redirect_uri)'
      : (() => {
          try {
            return new URL(effectiveRedirectUri).host;
          } catch (_) {
            return '(invalid redirect_uri)';
          }
        })(),
  });
  logEmbeddedSignupApi(
    'ES_COMPLETE_ONBOARDING_START',
    { method: 'PIPELINE', url: 'completeOnboarding' },
    {
      clientId: clientId != null ? Number(clientId) : null,
      selectedProjectId:
        selectedProjectId != null && Number(selectedProjectId) > 0
          ? Number(selectedProjectId)
          : null,
      omitRedirectUri,
      redirectUri: omitRedirectUri ? '' : effectiveRedirectUri,
      codePresent: Boolean(code),
      codeLength: code ? String(code).length : 0,
    },
    { status: 'started' }
  );

  const tokenParams = {
    client_id: APP_ID,
    client_secret: APP_SECRET,
    code,
  };
  if (!omitRedirectUri) {
    tokenParams.redirect_uri = effectiveRedirectUri;
  }

  const tokenRes = await loggedGraphRequest('ES_GRAPH_OAUTH_SHORT_TOKEN', {
    method: 'get',
    url: `https://graph.facebook.com/${API_VERSION}/oauth/access_token`,
    params: tokenParams,
  });
  if (tokenRes.status >= 400 || !tokenRes.data?.access_token) {
    const msg =
      tokenRes.data?.error?.message ||
      tokenRes.data?.error_description ||
      `oauth short token failed (${tokenRes.status})`;
    const err = new Error(msg);
    err.response = { status: tokenRes.status, data: tokenRes.data };
    throw err;
  }
  const shortToken = tokenRes.data.access_token;
  logOnboarding('short_lived_token', {
    received: Boolean(shortToken && String(shortToken).length > 0),
    length: shortToken ? String(shortToken).length : 0,
  });

  // 2) Convert to long-lived token
  const longRes = await loggedGraphRequest('ES_GRAPH_OAUTH_LONG_TOKEN', {
    method: 'get',
    url: `https://graph.facebook.com/${API_VERSION}/oauth/access_token`,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  if (longRes.status >= 400 || !longRes.data?.access_token) {
    const msg =
      longRes.data?.error?.message ||
      longRes.data?.error_description ||
      `oauth long token failed (${longRes.status})`;
    const err = new Error(msg);
    err.response = { status: longRes.status, data: longRes.data };
    throw err;
  }
  const longToken = longRes.data.access_token;
  const expiresIn = longRes.data.expires_in;
  const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  logOnboarding('long_lived_token', {
    received: Boolean(longToken && String(longToken).length > 0),
    length: longToken ? String(longToken).length : 0,
    expiresInSec: expiresIn != null ? Number(expiresIn) : null,
    tokenExpiry: tokenExpiry ? tokenExpiry.toISOString() : null,
  });

  // 3–4) WABA + phone (Graph no longer supports me.whatsapp_business_accounts on User for many apps)
  const { wabaId, phoneNumberId, businessId } = await resolveWabaAndPhoneFromToken(longToken);
  logOnboarding('waba_resolved', { wabaId, phoneNumberId });

  let displayPhone = null;
  try {
    const phoneRes = await loggedGraphRequest('ES_GRAPH_PHONE_DISPLAY', {
      method: 'get',
      url: `${graphBase()}/${encodeURIComponent(phoneNumberId)}`,
      headers: { Authorization: `Bearer ${longToken}` },
      params: { fields: 'display_phone_number' },
    });
    if (phoneRes.status < 400) {
      displayPhone = String(phoneRes.data?.display_phone_number || '').trim() || null;
    } else {
      logOnboarding('display_phone_fetch_skipped', {
        error: phoneRes.data?.error?.message || `status_${phoneRes.status}`,
      });
    }
  } catch (e) {
    logOnboarding('display_phone_fetch_skipped', { error: e?.message || String(e) });
  }

  // 5) Save to database (multi-tenant: client + whatsapp_accounts)
  let phoneRegistrationAttempt = {
    attempted: false,
    success: false,
    skipped: true,
    reason: 'aisensy_bsp_skips_graph_register_use_submit_waba',
  };
  let aisensySubmitFbToken = { attempted: false, ok: false };
  let directApiJwtRegenerate = { attempted: false, ok: false, skipped: true, reason: 'not_run' };
  let creditAttach = { attached: false, reason: 'not_attempted' };
  let subscribeResult = { subscribed: false, reason: 'not_attempted' };
  if (clientId != null) {
    await ensureWhatsAppAccountPaymentColumns();
    let aisensySolutionId = null;
    try {
      aisensySolutionId = await resolveMetaSolutionId();
    } catch (_) {
      /* optional */
    }
    let name = '';
    let email = '';
    let ownerProjectId = null;
    try {
      const user = await User.findByPk(clientId, { attributes: ['name', 'email', 'projectId'] });
      if (user) {
        name = user.name || '';
        email = user.email || '';
        ownerProjectId = user.projectId != null ? Number(user.projectId) : null;
      }
    } catch (e) {}
    const linkProjectId =
      selectedProjectId != null && Number(selectedProjectId) > 0
        ? Number(selectedProjectId)
        : ownerProjectId;
    await Client.findOrCreate({
      where: { id: clientId },
      defaults: { id: clientId, name, email },
    });
    const accountWhere =
      linkProjectId != null && Number(linkProjectId) > 0
        ? { client_id: clientId, projectId: Number(linkProjectId) }
        : { client_id: clientId, projectId: { [Op.or]: [{ [Op.eq]: null }, ''] } };
    if (!(linkProjectId != null && Number(linkProjectId) > 0)) {
      delete accountWhere.projectId;
      accountWhere[Op.and] = [
        { client_id: clientId },
        { [Op.or]: [{ projectId: null }, { projectId: '' }] },
      ];
    }
    const [account] = await WhatsAppAccount.findOrCreate({
      where:
        linkProjectId != null && Number(linkProjectId) > 0
          ? { client_id: clientId, projectId: Number(linkProjectId) }
          : { client_id: clientId, projectId: null },
      defaults: {
        client_id: clientId,
        business_id: businessId,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_phone: displayPhone,
        access_token: longToken,
        token_expiry: tokenExpiry,
        status: 'connected',
        account_status: 'ACTIVE',
        aisensy_solution_id: aisensySolutionId || null,
        projectId: linkProjectId != null ? Number(linkProjectId) : null,
      },
    });
    const wasNewWaAccount = Boolean(account.isNewRecord);
    if (!account.isNewRecord) {
      await account.update({
        business_id: businessId || account.business_id,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_phone: displayPhone,
        access_token: longToken,
        token_expiry: tokenExpiry,
        status: 'connected',
        account_status: 'ACTIVE',
        ...(!account.aisensy_solution_id && aisensySolutionId
          ? { aisensy_solution_id: aisensySolutionId }
          : {}),
        ...(account.projectId == null && linkProjectId != null ? { projectId: linkProjectId } : {}),
      });
    }
    logOnboarding('whatsapp_accounts_row', {
      accountId: account.id,
      clientId,
      projectId: linkProjectId,
      isNewRecord: wasNewWaAccount,
      tokenSaved: Boolean(longToken && String(longToken).length > 0),
      tokenLength: longToken ? String(longToken).length : 0,
      tokenExpiry: tokenExpiry ? tokenExpiry.toISOString() : null,
    });
    if (linkProjectId != null) {
      try {
        if (displayPhone) {
          await db.query(
            'UPDATE projects SET whatsapp_number_id = ?, whatsapp_display_phone = ? WHERE id = ?',
            [phoneNumberId, displayPhone, linkProjectId]
          );
        } else {
          await db.query(
            'UPDATE projects SET whatsapp_number_id = ? WHERE id = ?',
            [phoneNumberId, linkProjectId]
          );
        }
      } catch (e) {
        const msg = e?.message || '';
        if (msg.includes('Unknown column')) {
          try {
            await db.query('ALTER TABLE projects ADD COLUMN whatsapp_number_id VARCHAR(100) NULL');
            try {
              await db.query(
                'ALTER TABLE projects ADD COLUMN whatsapp_display_phone VARCHAR(32) NULL'
              );
            } catch (_) {
              /* may already exist */
            }
            if (displayPhone) {
              await db.query(
                'UPDATE projects SET whatsapp_number_id = ?, whatsapp_display_phone = ? WHERE id = ?',
                [phoneNumberId, displayPhone, linkProjectId]
              );
            } else {
              await db.query(
                'UPDATE projects SET whatsapp_number_id = ? WHERE id = ?',
                [phoneNumberId, linkProjectId]
              );
            }
          } catch (retryErr) {
            console.error('Could not map project to phone_number_id:', retryErr?.message || retryErr);
          }
        } else {
          console.error('Could not map project to phone_number_id:', msg || e);
        }
      }

      // Keep partner_businesses.contact in sync with the Meta-connected WhatsApp number
      if (displayPhone) {
        try {
          const digits = String(displayPhone).replace(/\D/g, '');
          if (digits) {
            await db.query(
              `UPDATE partner_businesses
               SET contact = ?
               WHERE user_id = ? AND project_id = ? AND active = 1`,
              [digits, clientId, linkProjectId]
            );
          }
        } catch (_) {
          /* non-fatal */
        }
      }
    }

    // AiSensy BSP: submit WABA immediately after Meta token exchange — never Graph POST .../register first
    // (Graph register enables 2FA and breaks submit-facebook-access-token with ERR400 133005).
    const lookProjectId =
      linkProjectId != null && Number(linkProjectId) > 0 ? Number(linkProjectId) : null;
    if (longToken && wabaId) {
      try {
        const { ensureAisensyPartnerRow, linkWabaToAisensyProject } = require('./newProjectWhatsAppService');
        const { resolveCanonicalAisensyAssistantId } = require('./partnerBusinessService');
        const Project = require('../models/Project');

        let partnerRow = null;
        let projectName = null;
        if (lookProjectId) {
          try {
            const project = await Project.findById(lookProjectId);
            projectName = project?.project_name || null;
          } catch (_) {
            /* non-fatal */
          }
        }

        const user = await User.findByPk(clientId);
        if (user && lookProjectId) {
          partnerRow = await ensureAisensyPartnerRow(
            user,
            lookProjectId,
            projectName || user.name || user.email
          );
          logOnboarding('partner_business_ensured', {
            businessId: partnerRow?.business_id,
            assistantId: partnerRow?.external_project_id,
            projectId: lookProjectId,
            email: partnerRow?.email,
            credentialsSaved: true,
          });
        } else if (lookProjectId) {
          partnerRow = await PartnerBusiness.findOne({
            where: { user_id: clientId, project_id: lookProjectId, active: true },
            order: [['id', 'DESC']],
          });
        }

        const assistantId = String(partnerRow?.external_project_id || '').trim();
        if (!assistantId || !partnerRow) {
          aisensySubmitFbToken = {
            attempted: false,
            ok: false,
            reason: 'missing_aisensy_project_id',
          };
          logOnboarding('aisensy_submit_fb_token_skipped', {
            clientId,
            projectId: lookProjectId,
            reason: 'missing_aisensy_project_id',
          });
        } else {
          let canonicalAssistantId = null;
          if (lookProjectId) {
            try {
              canonicalAssistantId = await resolveCanonicalAisensyAssistantId(clientId, lookProjectId);
            } catch (_) {
              /* non-fatal */
            }
          }

          const linkResult = await linkWabaToAisensyProject(partnerRow, account, {
            accessToken: String(longToken || '').trim(),
            canonicalAssistantId,
          });

          aisensySubmitFbToken = {
            attempted: true,
            ok: Boolean(linkResult.ok),
            assistantId: linkResult.assistantId || assistantId,
            wabaAppId: String(wabaId),
            status: linkResult.status,
            canonical: Boolean(linkResult.canonical),
            reason: linkResult.reason || null,
          };

          if (linkResult.ok) {
            logOnboarding('aisensy_submit_fb_token_ok', {
              clientId,
              projectId: lookProjectId,
              assistantId: aisensySubmitFbToken.assistantId,
              wabaAppId: String(wabaId),
              status: linkResult.status,
              canonical: aisensySubmitFbToken.canonical,
            });

            try {
              const { regenerateTokenDirectApi, resolveCredentialParts } = require('./aisensyDirectApiClient');
              directApiJwtRegenerate.attempted = true;
              directApiJwtRegenerate.skipped = false;
              const credentialParts = await resolveCredentialParts({
                localProjectId: lookProjectId,
                userId: clientId,
                externalProjectId: aisensySubmitFbToken.assistantId,
              });
              const regen = await regenerateTokenDirectApi({ credentialParts });
              directApiJwtRegenerate = {
                attempted: true,
                ok: Boolean(regen?.token),
                storeOk: Boolean(regen?.storeResult?.ok),
                assistantId: aisensySubmitFbToken.assistantId,
                localProjectId: lookProjectId,
                skipped: false,
              };
              logOnboarding('direct_api_jwt_regenerated_after_signup', directApiJwtRegenerate);
            } catch (regenErr) {
              directApiJwtRegenerate = {
                attempted: true,
                ok: false,
                storeOk: false,
                skipped: false,
                reason: regenErr?.message || 'regenerate_failed',
                assistantId: aisensySubmitFbToken.assistantId,
                localProjectId: lookProjectId,
              };
              logOnboarding('direct_api_jwt_regenerate_failed', directApiJwtRegenerate);
            }
          } else {
            logOnboarding('aisensy_submit_fb_token_failed', {
              clientId,
              projectId: lookProjectId,
              assistantId,
              wabaAppId: String(wabaId),
              reason: linkResult.reason || 'submit_failed',
            });
          }
        }
      } catch (submitErr) {
        aisensySubmitFbToken = {
          attempted: true,
          ok: false,
          reason: submitErr?.message || 'submit_failed',
          details: submitErr?.response?.data || null,
        };
        logOnboarding('aisensy_submit_fb_token_failed', {
          clientId,
          projectId: lookProjectId,
          message: submitErr?.message || String(submitErr),
          details: submitErr?.response?.data || null,
        });
      }

      subscribeResult = await ensureAppSubscribedToWaba(wabaId, longToken);
      if (!subscribeResult.subscribed) {
        logOnboarding('waba_subscribe_warning', {
          wabaId,
          reason: subscribeResult.reason || 'unknown',
        });
      }

      creditAttach = await attachExtendedCreditLineToWaba(wabaId, {
        currency: process.env.META_WABA_CURRENCY || 'INR',
      });
      if (!creditAttach.attached) {
        logOnboarding('waba_credit_line_attach_warning', {
          wabaId,
          billingPath: 'A_aisensy_partner',
          reason: creditAttach.reason || 'unknown',
          note:
            'Path A: Meta Summary may show No payment method until credit attach succeeds or Tech Provider Reseller ToS is accepted.',
          nextSteps: [
            'Accept Credit Allocation / Business Messaging Tech Provider Reseller terms in Meta Business Suite',
            'Confirm META_EXTENDED_CREDIT_LINE_ID and META_SYSTEM_USER_TOKEN in server .env',
            'Re-run Connect WhatsApp after terms are accepted',
          ],
        });
      } else {
        try {
          await db.query(
            `UPDATE whatsapp_accounts
             SET aisensy_credit_line_attached = 1,
                 aisensy_payment_method_ready = 1,
                 aisensy_credit_line_attached_at = NOW()
             WHERE id = ?`,
            [account.id]
          );
        } catch (_) {
          /* non-fatal */
        }
      }
    }

    try {
      const cwaWhere =
        linkProjectId != null && Number(linkProjectId) > 0
          ? { client_id: clientId, project_id: Number(linkProjectId) }
          : { client_id: clientId };
      const [cwaRow] = await ClientWhatsApp.findOrCreate({
        where: cwaWhere,
        defaults: {
          client_id: clientId,
          project_id:
            linkProjectId != null && Number(linkProjectId) > 0 ? Number(linkProjectId) : null,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          access_token: longToken,
        },
      });
      if (!cwaRow.isNewRecord) {
        await cwaRow.update({
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          access_token: longToken,
          ...(cwaRow.project_id == null &&
          linkProjectId != null &&
          Number(linkProjectId) > 0
            ? { project_id: Number(linkProjectId) }
            : {}),
        });
      }
    } catch (cwaErr) {
      logOnboarding('clients_whatsapp_sync_skipped', {
        error: cwaErr?.message || String(cwaErr),
      });
    }
  } else {
    logOnboarding('skip_db_persist', { reason: 'clientId is null (token exchange + WABA still ran)' });
  }

  const resolvedProjectId =
    selectedProjectId != null && Number(selectedProjectId) > 0
      ? Number(selectedProjectId)
      : null;

  const result = {
    wabaId,
    phoneNumberId,
    businessId: businessId || null,
    displayPhone,
    clientId: clientId != null ? Number(clientId) : null,
    projectId: resolvedProjectId,
    onboardingCompleted: Boolean(wabaId && phoneNumberId && longToken),
    metaLinked: Boolean(wabaId && phoneNumberId && longToken),
    aisensyLinked: Boolean(aisensySubmitFbToken?.ok),
    directApiJwtReady: Boolean(directApiJwtRegenerate?.ok),
    directApiJwtRegenerate,
    creditLineAttached: Boolean(creditAttach?.attached),
    creditLineAttach: creditAttach,
    wabaSubscribed: Boolean(subscribeResult?.subscribed),
    linkedAt: new Date().toISOString(),
    phoneRegistrationAttempt,
    aisensySubmitFbToken,
  };
  logEmbeddedSignupApi(
    'ES_COMPLETE_ONBOARDING_DONE',
    { method: 'PIPELINE', url: 'completeOnboarding' },
    {
      clientId: result.clientId,
      projectId: result.projectId,
    },
    result
  );
  return result;
};

exports.getOnboardingStatus = async (clientId, selectedProjectId = null) => {
  await ensureWhatsAppAccountPaymentColumns();
  if (clientId == null || Number.isNaN(Number(clientId))) {
    return {
      onboardingCompleted: false,
      reason: 'Invalid clientId',
    };
  }

  const account = await findWhatsAppAccountRow(clientId, selectedProjectId);

  if (!account) {
    return {
      onboardingCompleted: false,
      reason: 'No WhatsApp account mapping found',
      clientId: Number(clientId),
      projectId: selectedProjectId != null ? Number(selectedProjectId) : null,
    };
  }

  const wabaId = String(account.waba_id || '').trim();
  const phoneNumberId = String(account.phone_number_id || '').trim();
  const storedDisplayPhone = String(account.display_phone || '').trim();
  const token = String(account.access_token || '').trim();
  const metaLinked = Boolean(wabaId && phoneNumberId && token);
  const onboardingCompleted = metaLinked;

  let cloudApiPhone = null;
  let cloudApiPhoneError = null;
  if (metaLinked && token && phoneNumberId) {
    try {
      cloudApiPhone = await fetchCloudApiPhoneRegistrationState(phoneNumberId, token);
    } catch (e) {
      cloudApiPhoneError = e?.message || String(e);
    }
  }

  const cvsRaw = cloudApiPhone?.code_verification_status;
  const codeVerificationStatus =
    cvsRaw != null && String(cvsRaw).trim() !== '' ? String(cvsRaw).trim() : null;
  const cvsUpper =
    codeVerificationStatus != null ? String(codeVerificationStatus).toUpperCase() : null;

  const accountStatus = String(account.status || '').trim().toLowerCase();

  let aisensyLink = { attempted: false, ok: false };
  const statusProjectId =
    selectedProjectId != null && Number(selectedProjectId) > 0
      ? Number(selectedProjectId)
      : account.projectId != null && Number(account.projectId) > 0
        ? Number(account.projectId)
        : null;

  if (metaLinked && statusProjectId) {
    try {
      const { ensureAisensyPartnerRow, linkWabaToAisensyProject } = require('./newProjectWhatsAppService');
      const { resolveCanonicalAisensyAssistantId } = require('./partnerBusinessService');
      const Project = require('../models/Project');
      const user = await User.findByPk(Number(clientId));
      let projectName = null;
      try {
        const project = await Project.findById(statusProjectId);
        projectName = project?.project_name || null;
      } catch (_) {
        /* non-fatal */
      }
      if (user) {
        const partnerRow = await ensureAisensyPartnerRow(
          user,
          statusProjectId,
          projectName || user.name || user.email
        );
        if (partnerRow) {
          let canonicalAssistantId = null;
          try {
            canonicalAssistantId = await resolveCanonicalAisensyAssistantId(
              Number(clientId),
              statusProjectId
            );
          } catch (_) {
            /* non-fatal */
          }
          aisensyLink = await linkWabaToAisensyProject(partnerRow, account, {
            accessToken: token,
            canonicalAssistantId,
          });
          aisensyLink.attempted = true;
        }
      }
    } catch (linkErr) {
      aisensyLink = {
        attempted: true,
        ok: false,
        reason: linkErr?.message || String(linkErr),
      };
    }
  }

  if (metaLinked) {
    try {
      if (accountStatus !== 'connected' || String(account.account_status || '').toUpperCase() !== 'ACTIVE') {
        await account.update({ status: 'connected', account_status: 'ACTIVE' });
        account.status = 'connected';
        account.account_status = 'ACTIVE';
      }
    } catch (_) {
      /* non-fatal */
    }
  }

  const aisensyLinked = Boolean(aisensyLink.ok);
  const paymentMethodReady = aisensyLinked;
  const creditLineAttached = aisensyLinked;

  /** AiSensy BSP: app shows Connected when WABA + token are saved (Graph /register is optional). */
  const needsCloudApiRegistration = false;

  const cloudApiMessagingLikelyReady = onboardingCompleted;

  const displayPhone =
    String(cloudApiPhone?.display_phone_number || storedDisplayPhone || '').trim() || null;

  const readyToSendMessages = metaLinked && aisensyLinked;

  return {
    onboardingCompleted: onboardingCompleted && aisensyLinked,
    connected: onboardingCompleted && aisensyLinked,
    metaLinked,
    whatsappConnected: onboardingCompleted && aisensyLinked,
    readyToSendMessages,
    creditLineAttached,
    paymentMethodReady,
    aisensyLinked,
    aisensySubmit: aisensyLink.attempted
      ? {
          ok: aisensyLink.ok,
          assistantId: aisensyLink.assistantId || null,
          reason: aisensyLink.reason || null,
        }
      : null,
    accountStatus: metaLinked && aisensyLinked ? 'LIVE' : account.status || account.account_status || null,
    businessId: account.business_id || null,
    clientId: Number(account.client_id),
    projectId: account.projectId != null ? Number(account.projectId) : null,
    wabaId: wabaId || null,
    phoneNumberId: phoneNumberId || null,
    displayPhone,
    tokenExpiry: account.token_expiry || null,
    linkedAt: account.created_at || null,
    reason: metaLinked
      ? null
      : 'Incomplete WhatsApp linkage data — connect via Meta Embedded Signup',
    codeVerificationStatus,
    cloudApiPhone: cloudApiPhoneError ? null : cloudApiPhone || null,
    cloudApiPhoneError,
    needsCloudApiRegistration,
    cloudApiMessagingLikelyReady,
    cloudApiRegisterAttempt: null,
  };
};

/**
 * Registers the linked business number with WhatsApp Cloud API (two-step PIN).
 */
exports.registerCloudApiPhoneForLinkedAccount = async (
  clientId,
  selectedProjectId,
  pin,
  options = {}
) => {
  const account = await findWhatsAppAccountRow(clientId, selectedProjectId);
  if (!account) {
    const err = new Error('No WhatsApp account linked for this user/project');
    err.statusCode = 404;
    throw err;
  }
  const phoneId = String(account.phone_number_id || '').trim();
  const token = String(account.access_token || '').trim();
  if (!phoneId || !token) {
    const err = new Error('Missing phone_number_id or access_token; reconnect Meta onboarding');
    err.statusCode = 400;
    throw err;
  }
  await registerWhatsAppPhoneForCloudApi(phoneId, token, pin, options);
  let cloudApiPhone = null;
  try {
    cloudApiPhone = await fetchCloudApiPhoneRegistrationState(phoneId, token);
  } catch (e) {
    /* non-fatal */
  }
  const cvsUpper =
    cloudApiPhone?.code_verification_status != null
      ? String(cloudApiPhone.code_verification_status).toUpperCase()
      : null;
  return {
    success: true,
    phoneNumberId: phoneId,
    cloudApiPhone,
    needsCloudApiRegistration: cvsUpper != null ? cvsUpper !== 'VERIFIED' : false,
    codeVerificationStatus: cloudApiPhone?.code_verification_status || null,
  };
};

exports.requestCloudApiPhoneOtp = async (clientId, selectedProjectId, opts = {}) => {
  const account = await findWhatsAppAccountRow(clientId, selectedProjectId);
  if (!account) {
    const err = new Error('No WhatsApp account linked for this user/project');
    err.statusCode = 404;
    throw err;
  }
  const phoneId = String(account.phone_number_id || '').trim();
  const token = String(account.access_token || '').trim();
  if (!phoneId || !token) {
    const err = new Error('Missing phone_number_id or access_token; reconnect Meta onboarding');
    err.statusCode = 400;
    throw err;
  }
  await requestWhatsAppPhoneVerificationCode(phoneId, token, opts);
  return { success: true, phoneNumberId: phoneId };
};

exports.verifyCloudApiPhoneOtp = async (clientId, selectedProjectId, code) => {
  const account = await findWhatsAppAccountRow(clientId, selectedProjectId);
  if (!account) {
    const err = new Error('No WhatsApp account linked for this user/project');
    err.statusCode = 404;
    throw err;
  }
  const phoneId = String(account.phone_number_id || '').trim();
  const token = String(account.access_token || '').trim();
  if (!phoneId || !token) {
    const err = new Error('Missing phone_number_id or access_token; reconnect Meta onboarding');
    err.statusCode = 400;
    throw err;
  }
  await verifyWhatsAppPhoneWithOtpCode(phoneId, token, code);
  return { success: true, phoneNumberId: phoneId };
};
