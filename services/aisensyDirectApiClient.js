const axios = require('axios');
const jwt = require('jsonwebtoken');
const { logDirectApi, logWhatsAppSend } = require('../utils/directApiLogger');
const { maskBearer } = require('../utils/directApiLogger');
const { normalizeWhatsAppRecipient, hasRecipientPhone } = require('../utils/phoneNormalize');
const { normalizeDirectApiOutboundPayload } = require('../utils/directApiPayloadUtil');

const REGENERATE_PATH =
  String(process.env.AISENSY_DIRECT_API_REGENERATE_PATH || '/direct-apis/t1/users/regenrate-token').trim() ||
  '/direct-apis/t1/users/regenrate-token';

const SEND_MESSAGES_PATH =
  String(process.env.AISENSY_DIRECT_API_SEND_PATH || '/direct-apis/t1/messages').trim() ||
  '/direct-apis/t1/messages';

const MARKETING_MESSAGES_PATH =
  String(process.env.AISENSY_DIRECT_API_MARKETING_SEND_PATH || '/direct-apis/t1/marketing_messages').trim() ||
  '/direct-apis/t1/marketing_messages';

const UPDATE_WEBHOOK_PATH =
  String(
    process.env.AISENSY_DIRECT_API_UPDATE_WEBHOOK_PATH || '/direct-apis/t1/settings/update-webhook'
  ).trim() || '/direct-apis/t1/settings/update-webhook';

const GET_PROFILE_PATH =
  String(process.env.AISENSY_DIRECT_API_GET_PROFILE_PATH || '/direct-apis/t1/get-profile').trim() ||
  '/direct-apis/t1/get-profile';

const GET_BUSINESS_INFO_PATH =
  String(
    process.env.AISENSY_DIRECT_API_GET_BUSINESS_INFO_PATH || '/direct-apis/t1/get-business-info'
  ).trim() || '/direct-apis/t1/get-business-info';

function getDirectApiSendPath(isMarketing = false) {
  const path = isMarketing ? MARKETING_MESSAGES_PATH : SEND_MESSAGES_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}

function getUpdateWebhookPath() {
  return UPDATE_WEBHOOK_PATH.startsWith('/') ? UPDATE_WEBHOOK_PATH : `/${UPDATE_WEBHOOK_PATH}`;
}

function getProfilePath() {
  return GET_PROFILE_PATH.startsWith('/') ? GET_PROFILE_PATH : `/${GET_PROFILE_PATH}`;
}

function getBusinessInfoPath() {
  return GET_BUSINESS_INFO_PATH.startsWith('/') ? GET_BUSINESS_INFO_PATH : `/${GET_BUSINESS_INFO_PATH}`;
}

function resolveDirectApiWebhookUrl(overrideUrl) {
  return String(
    overrideUrl ||
      process.env.AISENSY_DIRECT_API_WEBHOOK_URL ||
      process.env.WEBHOOK_URL ||
      ''
  ).trim();
}

/** In-memory cache keyed by base|projectId (DB is source of truth per account). */
let jwtCache = { token: '', expiresAt: 0, base: '', projectId: '' };

function jwtCacheKey(base, projectId) {
  return `${String(base || '').replace(/\/$/, '')}|${String(projectId || '').trim()}`;
}

function getOfficialDirectApiBase() {
  return String(
    process.env.AISENSY_DIRECT_API_OFFICIAL_BASE || 'https://backend.aisensy.com'
  ).replace(/\/$/, '');
}

function getSelfDirectApiBase() {
  return String(
    process.env.AISENSY_DIRECT_API_BASE || process.env.AISENSY_DIRECT_API_SELF_BASE || ''
  ).replace(/\/$/, '');
}

function getPrimaryDirectApiBase() {
  const mode = String(process.env.AISENSY_DIRECT_API_PRIMARY || 'official').toLowerCase();
  if (mode === 'self' || mode === 'local' || mode === 'waabizx') {
    return getSelfDirectApiBase() || getOfficialDirectApiBase();
  }
  return getOfficialDirectApiBase() || getSelfDirectApiBase();
}

function getDirectApiBasesForProbe() {
  const bases = [];
  const official = getOfficialDirectApiBase();
  const self = getSelfDirectApiBase();
  const primary = String(process.env.AISENSY_DIRECT_API_PRIMARY || 'official').toLowerCase();
  const probeSelf = String(process.env.AISENSY_DIRECT_API_PROBE_SELF || '').toLowerCase();

  if (official) bases.push({ label: 'official', base: official });
  // Skip self-hosted probe when using official AiSensy (avoids confusing Invalid Key logs)
  const includeSelf =
    probeSelf === '1' ||
    probeSelf === 'true' ||
    probeSelf === 'yes' ||
    primary === 'self' ||
    primary === 'local' ||
    primary === 'waabizx';
  if (includeSelf && self && self !== official) {
    bases.push({ label: 'self', base: self });
  }
  return bases;
}

function getCredentialPartsFromEnv() {
  const email = String(
    process.env.AISENSY_DIRECT_API_EMAIL || process.env.AISENSY_DIRECT_API_USERNAME || ''
  ).trim();
  const password = String(process.env.AISENSY_DIRECT_API_PASSWORD || '').trim();
  const projectId = String(
    process.env.AISENSY_DIRECT_API_PROJECT_ID || process.env.AISENSY_PROJECT_ID || ''
  ).trim();
  return { email, password, projectId };
}

async function resolveCredentialParts(hint = {}) {
  const localProjectId =
    hint.localProjectId != null && Number(hint.localProjectId) > 0
      ? Number(hint.localProjectId)
      : hint.projectId != null && /^\d+$/.test(String(hint.projectId)) && Number(hint.projectId) > 0
        ? Number(hint.projectId)
        : null;
  const externalHint = String(hint.externalProjectId || '').trim()
    || (hint.projectId && !/^\d+$/.test(String(hint.projectId)) ? String(hint.projectId).trim() : '');

  const envParts = getCredentialPartsFromEnv();

  let fromDb = null;
  const lookupIds = [];
  if (localProjectId) lookupIds.push(String(localProjectId));
  if (externalHint) lookupIds.push(externalHint);
  for (const lookupId of lookupIds) {
    try {
      const { getDirectApiCredentialPartsForProject } = require('./partnerBusinessService');
      fromDb = await getDirectApiCredentialPartsForProject(lookupId);
      if (fromDb) break;
    } catch (_) {
      /* use .env */
    }
  }

  // Prefer .env email/password when set. partner_businesses often stores onboarding
  // alias emails (e.g. poonam@…) that AiSensy rejects with
  // "Illegal arguments: string, undefined". Business-owner login (info@…) works.
  const preferEnvAuth = String(process.env.AISENSY_DIRECT_API_PREFER_ENV_AUTH || 'true')
    .trim()
    .toLowerCase();
  const useEnvAuth =
    preferEnvAuth !== '0' &&
    preferEnvAuth !== 'false' &&
    preferEnvAuth !== 'no' &&
    Boolean(envParts.email && envParts.password);

  const projectIdFromDb = fromDb?.projectId ? String(fromDb.projectId).trim() : '';
  const hasLocalProject = localProjectId != null && localProjectId > 0;

  let aisensyAssistantId =
    projectIdFromDb ||
    externalHint ||
    (!hasLocalProject ? envParts.projectId : '') ||
    '';

  if (hasLocalProject && hint.userId) {
    try {
      const { resolveCanonicalAisensyAssistantId } = require('./partnerBusinessService');
      const canonical = await resolveCanonicalAisensyAssistantId(hint.userId, localProjectId);
      if (canonical) {
        aisensyAssistantId = canonical;
      }
    } catch (_) {
      /* keep aisensyAssistantId */
    }
  }

  const projectId = aisensyAssistantId;

  if (useEnvAuth && projectId) {
    return {
      email: envParts.email,
      password: envParts.password,
      projectId,
      localProjectId: fromDb?.localProjectId || localProjectId || null,
      source: projectIdFromDb ? 'env+partner_project' : 'env',
    };
  }

  if (fromDb?.email && fromDb?.password && fromDb?.projectId) {
    return {
      email: fromDb.email,
      password: fromDb.password,
      projectId: String(fromDb.projectId),
      localProjectId: fromDb.localProjectId,
      source: fromDb.source || 'partner_businesses',
    };
  }

  if (hasLocalProject && !projectId) {
    const err = new Error(
      `No AiSensy project mapping for local project ${localProjectId}. Connect WhatsApp for this project first.`
    );
    err.statusCode = 403;
    throw err;
  }

  if (fromDb?.projectId && useEnvAuth) {
    return {
      email: envParts.email,
      password: envParts.password,
      projectId: String(fromDb.projectId),
      localProjectId: fromDb.localProjectId || localProjectId || null,
      source: 'env+partner_project',
    };
  }

  return { ...envParts, source: 'env' };
}

async function loadStoredJwtForAccount(projectIdOrExternal) {
  const id = String(projectIdOrExternal || '').trim();
  if (!id) return null;
  try {
    const { getStoredDirectApiJwt } = require('./partnerBusinessService');
    return getStoredDirectApiJwt(id);
  } catch (_) {
    return null;
  }
}

async function persistJwtForAccount(projectIdOrExternal, token, expiresAtMs, hints = {}) {
  const id = String(projectIdOrExternal || '').trim();
  const jwtToken = String(token || '').trim();
  if (!jwtToken) {
    return { ok: false, reason: 'empty_token' };
  }
  try {
    const { saveDirectApiJwt } = require('./partnerBusinessService');
    const result = await saveDirectApiJwt(
      id || hints.assistantId || '',
      jwtToken,
      expiresAtMs != null ? new Date(expiresAtMs) : null,
      { email: hints.email }
    );
    if (!result?.ok) {
      logDirectApi(
        'DIRECT_API_JWT_STORE_ERROR',
        {
          projectId: id,
          email: hints.email || null,
          reason: result?.reason || 'save_failed',
          assistantId: result?.assistantId || null,
        },
        null,
        {
          message:
            result?.reason === 'no_partner_business_row'
              ? 'No partner_businesses row matched this project/JWT — direct_api_jwt stays NULL'
              : result?.reason || 'save_failed',
        }
      );
    }
    return result || { ok: false, reason: 'save_failed' };
  } catch (e) {
    logDirectApi(
      'DIRECT_API_JWT_STORE_ERROR',
      { projectId: id, email: hints.email || null },
      null,
      { message: e.message }
    );
    return { ok: false, reason: 'exception', message: e.message };
  }
}

async function clearStoredJwtForAccount(projectIdOrExternal) {
  const id = String(projectIdOrExternal || '').trim();
  if (!id) return;
  try {
    const { clearDirectApiJwt } = require('./partnerBusinessService');
    await clearDirectApiJwt(id);
  } catch (_) {
    /* non-fatal */
  }
}

async function buildStaticBearer(credentialParts = null) {
  const preset = String(
    process.env.AISENSY_DIRECT_API_STATIC_BEARER || process.env.AISENSY_DIRECT_API_BEARER || ''
  ).trim();
  if (preset) return { encoded: preset, credentialString: '(static bearer preset)' };

  const parts = credentialParts || (await resolveCredentialParts());
  const { email, password, projectId } = parts;
  if (!email || !password || !projectId) return { encoded: '', credentialString: '' };
  const credentialString = `${email}:${password}:${projectId}`;
  return {
    encoded: Buffer.from(credentialString, 'utf8').toString('base64'),
    credentialString,
    email,
    projectId,
  };
}

function extractJwt(data) {
  if (!data || typeof data !== 'object') return '';
  const fromUsers = Array.isArray(data.users) ? data.users[0]?.token || data.users[0]?.access_token : '';
  return String(
    fromUsers ||
      data.authorizationToken ||
      data.authorization_token ||
      data.token ||
      data.access_token ||
      data.jwt ||
      data?.data?.token ||
      data?.data?.authorizationToken ||
      data?.data?.users?.[0]?.token ||
      ''
  ).trim();
}

function extractJwtTtlSeconds(data) {
  const raw = Number(
    data?.expiresIn || data?.expires_in || data?.ttl || data?.data?.expiresIn || data?.data?.expires_in
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

function directApiUrl(base, path) {
  const b = String(base || '').replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function formatApiError(data, status) {
  if (typeof data === 'string' && data.trim()) return data.trim();
  const msg =
    data?.message ||
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : '');
  return msg ? String(msg) : `AiSensy Direct API error (${status})`;
}

function normalizeSendResponse(data) {
  if (data?.messages?.[0]?.id) return data;
  const id =
    data?.messages?.[0]?.messageId ||
    data?.messageId ||
    data?.message_id ||
    data?.id ||
    data?.data?.messages?.[0]?.id;
  if (id) {
    return { messaging_product: 'whatsapp', contacts: data?.contacts, messages: [{ id: String(id) }] };
  }
  return data;
}

function getDirectApiAuthMode() {
  return String(process.env.AISENSY_DIRECT_API_AUTH_MODE || 'base64').trim().toLowerCase();
}

function usesJwtAuthMode() {
  const mode = getDirectApiAuthMode();
  return mode === 'jwt' || mode === 'regenerate' || mode === 'regenrate-token';
}

function shouldProbeRegenerateToken() {
  const raw = String(process.env.AISENSY_DIRECT_API_PROBE_REGENERATE ?? 'true').toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

/**
 * AiSensy Direct API auth:
 * - regenrate-token: Bearer BASE64(email:password:projectId)
 * - send /messages: Bearer JWT stored per account (DB) or from regenrate-token
 * - each partner_businesses row stores its own direct_api_jwt
 */
async function resolveDirectApiAuthorization(options = {}) {
  const localProjectId =
    options.localProjectId != null && Number(options.localProjectId) > 0
      ? Number(options.localProjectId)
      : options.projectId != null && /^\d+$/.test(String(options.projectId)) && Number(options.projectId) > 0
        ? Number(options.projectId)
        : null;
  const externalProjectId = String(
    options.externalProjectId ||
      (options.projectId && !/^\d+$/.test(String(options.projectId)) ? options.projectId : '') ||
      ''
  ).trim();

  const credentialParts =
    options.credentialParts ||
    (await resolveCredentialParts({
      externalProjectId,
      localProjectId,
      userId: options.userId,
    }));
  const bearer = await buildStaticBearer(credentialParts);
  const aisensyProjectId = String(credentialParts.projectId || externalProjectId || '').trim();
  const accountKey = aisensyProjectId || String(localProjectId || '').trim();
  const hasProjectScope = Boolean(localProjectId || externalProjectId || aisensyProjectId);

  if (usesJwtAuthMode() || options.forceJwt) {
    const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
    const now = Date.now();
    let jwtToken = options.jwt || '';
    let jwtSource = options.jwt ? 'options' : '';

    // 1) Per-account JWT from DB (lookup local project id + AiSensy assistant id)
    if (!jwtToken && !options.skipStoredJwt) {
      const jwtLookupKeys = [];
      if (localProjectId) jwtLookupKeys.push(String(localProjectId));
      if (aisensyProjectId) jwtLookupKeys.push(aisensyProjectId);
      if (externalProjectId && !jwtLookupKeys.includes(externalProjectId)) {
        jwtLookupKeys.push(externalProjectId);
      }
      for (const key of jwtLookupKeys) {
        const stored = await loadStoredJwtForAccount(key);
        if (stored?.token) {
          jwtToken = stored.token;
          jwtSource = 'partner_businesses.direct_api_jwt';
          const expMs = stored.expiresAt ? new Date(stored.expiresAt).getTime() : now + 3600_000;
          jwtCache = {
            token: jwtToken,
            expiresAt: expMs,
            base,
            projectId: aisensyProjectId || key,
          };
          break;
        }
      }
    }

    // 1b) Env static Bearer only when no project scope (never reuse one JWT across projects)
    if (!jwtToken && !options.skipStoredJwt && !hasProjectScope) {
      const preset = String(
        process.env.AISENSY_DIRECT_API_STATIC_BEARER || process.env.AISENSY_DIRECT_API_BEARER || ''
      ).trim();
      if (preset.startsWith('eyJ')) {
        jwtToken = preset;
        jwtSource = 'env_static_bearer';
        let expiresAt = now + 30 * 24 * 3600 * 1000;
        try {
          const decoded = jwt.decode(preset);
          if (decoded?.exp) expiresAt = decoded.exp * 1000;
        } catch (_) {
          /* keep default */
        }
        jwtCache = { token: jwtToken, expiresAt, base, projectId: accountKey };
        if (accountKey) {
          await persistJwtForAccount(accountKey, jwtToken, expiresAt, {
            email: credentialParts.email,
            assistantId: accountKey,
          });
        }
      }
    }

    // 2) In-memory cache for same AiSensy project
    if (
      !jwtToken &&
      jwtCache.token &&
      jwtCache.expiresAt > now + 60_000 &&
      accountKey &&
      jwtCacheKey(jwtCache.base, jwtCache.projectId) === jwtCacheKey(base, accountKey)
    ) {
      jwtToken = jwtCache.token;
      jwtSource = 'memory';
    }

    // 3) Regenerate + persist per AiSensy project (email:password:assistantId)
    if (!jwtToken) {
      const regen = await regenerateTokenDirectApi({ base, credentialParts });
      jwtToken = regen.token;
      jwtSource = 'regenrate-token';
    }

    logDirectApi(
      'DIRECT_API_AUTH_JWT',
      {
        authMode: 'jwt',
        jwtSource,
        localProjectId,
        aisensyProjectId: accountKey,
        email: credentialParts.email,
      },
      null,
      { authorization: maskBearer(`Bearer ${jwtToken}`) }
    );

    return {
      authMode: 'jwt',
      authorizationHeader: `Bearer ${jwtToken}`,
      credentialParts,
      jwtSource,
      credentialFormat: bearer.credentialString
        ? `${credentialParts.email}:***:${credentialParts.projectId}`
        : '(missing)',
    };
  }

  if (!bearer.encoded) {
    throw new Error(
      'Direct API credentials missing. Set AISENSY_DIRECT_API_EMAIL, AISENSY_DIRECT_API_PASSWORD, AISENSY_DIRECT_API_PROJECT_ID'
    );
  }

  logDirectApi(
    'DIRECT_API_AUTH_BASE64_KEY',
    {
      authMode: 'base64',
      step: 'Bearer BASE64(email:password:projectId) — generated on each API call',
      email: credentialParts.email,
      projectId: credentialParts.projectId,
      credentialFormat: `${credentialParts.email}:***:${credentialParts.projectId}`,
    },
    null,
    { authorization: maskBearer(`Bearer ${bearer.encoded}`) }
  );

  return {
    authMode: 'base64',
    authorizationHeader: `Bearer ${bearer.encoded}`,
    credentialParts,
    credentialFormat: `${credentialParts.email}:***:${credentialParts.projectId}`,
  };
}

/**
 * Optional JWT flow — POST /direct-apis/t1/users/regenrate-token
 * Only used when AISENSY_DIRECT_API_AUTH_MODE=jwt
 */
async function regenerateTokenDirectApi(options = {}) {
  const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
  const credentialParts = options.credentialParts || (await resolveCredentialParts());
  const bearer = options.staticBearer
    ? { encoded: options.staticBearer, credentialString: '(provided staticBearer)' }
    : await buildStaticBearer(credentialParts);
  const staticBearer = bearer.encoded;

  const path = REGENERATE_PATH.startsWith('/') ? REGENERATE_PATH : `/${REGENERATE_PATH}`;
  const url = directApiUrl(base, path);
  const payload = { direct_api: options.directApi !== false };

  const request = {
    step: 'AiSensy Direct API regenerate JWT (docs: email:password:projectId → Base64 → Bearer)',
    method: 'POST',
    url,
    base,
    path,
    credentialSource: credentialParts.source || 'env',
    email: credentialParts.email,
    projectId: credentialParts.projectId,
    credentialFormat: bearer.credentialString
      ? `${credentialParts.email || bearer.email}:***:${credentialParts.projectId || bearer.projectId}`
      : '(missing)',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: maskBearer(`Bearer ${staticBearer}`),
    },
  };

  if (!staticBearer) {
    const err = new Error(
      'Direct API credentials missing. Set AISENSY_DIRECT_API_EMAIL, AISENSY_DIRECT_API_PASSWORD, AISENSY_DIRECT_API_PROJECT_ID in backend/.env'
    );
    logDirectApi('DIRECT_API_REGENERATE_TOKEN_ERROR', request, payload, { message: err.message });
    throw err;
  }

  logDirectApi('DIRECT_API_REGENERATE_TOKEN_CALLING', request, payload, { status: 'pending' });

  let res = await axios.post(url, payload, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${staticBearer}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  // AiSensy returns this when email has no password hash (wrong/alias email).
  // Retry once with .env business-owner credentials + same projectId.
  const illegalArgs =
    res.status >= 400 &&
    /Illegal arguments:\s*string,\s*undefined/i.test(String(res.data?.message || ''));
  if (illegalArgs && !options.skipEnvAuthRetry) {
    const envParts = getCredentialPartsFromEnv();
    const sameEmail =
      String(credentialParts.email || '').trim().toLowerCase() ===
      String(envParts.email || '').trim().toLowerCase();
    if (envParts.email && envParts.password && envParts.projectId && !sameEmail) {
      const retryParts = {
        email: envParts.email,
        password: envParts.password,
        projectId: String(credentialParts.projectId || envParts.projectId).trim(),
        source: 'env_retry_after_illegal_args',
      };
      const retryBearer = await buildStaticBearer(retryParts);
      if (retryBearer.encoded) {
        logDirectApi(
          'DIRECT_API_REGENERATE_TOKEN_ENV_RETRY',
          {
            ...request,
            email: retryParts.email,
            projectId: retryParts.projectId,
            credentialSource: retryParts.source,
            credentialFormat: `${retryParts.email}:***:${retryParts.projectId}`,
            previousEmail: credentialParts.email,
            previousError: res.data?.message,
          },
          payload,
          { status: 'retrying' }
        );
        res = await axios.post(url, payload, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${retryBearer.encoded}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
          validateStatus: () => true,
        });
        // Prefer retry identity for JWT persist / logging below
        Object.assign(credentialParts, retryParts);
        request.email = retryParts.email;
        request.projectId = retryParts.projectId;
        request.credentialSource = retryParts.source;
        request.credentialFormat = `${retryParts.email}:***:${retryParts.projectId}`;
      }
    }
  }

  const token = extractJwt(res.data);
  const response = {
    status: res.status,
    statusText: res.statusText,
    data: res.data,
    tokenGenerated: Boolean(token),
    jwtTokenPreview: token ? `${token.slice(0, 12)}...${token.slice(-8)}` : null,
  };

  logDirectApi('DIRECT_API_REGENERATE_TOKEN', request, payload, response);

  if (res.status >= 400) {
    const err = new Error(formatApiError(res.data, res.status));
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  if (!token) {
    const err = new Error('Direct API auth response did not include a JWT token');
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  const now = Date.now();
  let ttlSec = extractJwtTtlSeconds(res.data);
  try {
    const decoded = jwt.decode(token);
    if (decoded?.exp) {
      ttlSec = Math.max(60, decoded.exp - Math.floor(now / 1000));
    } else if (decoded && decoded.exp == null) {
      ttlSec = 30 * 24 * 3600;
    }
  } catch (_) {
    /* keep ttl */
  }

  const expiresAt = now + ttlSec * 1000;
  let accountKey = String(credentialParts.projectId || '').trim();
  let assistantIdFromJwt = '';
  try {
    const decoded = jwt.decode(token);
    assistantIdFromJwt = String(decoded?.assistantId || '').trim();
    if (assistantIdFromJwt) accountKey = assistantIdFromJwt;
  } catch (_) {
    /* keep accountKey */
  }
  jwtCache = { token, expiresAt, base, projectId: accountKey };

  // AiSensy note: store JWT Bearer per account (partner_businesses.direct_api_jwt)
  const storeHints = {
    email: credentialParts.email,
    assistantId: assistantIdFromJwt || accountKey,
  };
  let storeResult = await persistJwtForAccount(accountKey, token, expiresAt, storeHints);
  if (credentialParts.localProjectId) {
    const localStore = await persistJwtForAccount(
      credentialParts.localProjectId,
      token,
      expiresAt,
      storeHints
    );
    if (!storeResult?.ok) storeResult = localStore;
  }

  if (storeResult?.ok) {
    logDirectApi(
      'DIRECT_API_JWT_STORED',
      {
        projectId: accountKey,
        localProjectId: credentialParts.localProjectId || null,
        dbId: storeResult.id,
        external_project_id: storeResult.external_project_id,
      },
      null,
      {
        table: 'partner_businesses',
        columns: ['direct_api_jwt', 'direct_api_jwt_expires_at'],
        jwtTokenPreview: `${token.slice(0, 12)}...${token.slice(-8)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    );
  }

  return { token, base, status: res.status, data: res.data, credentialParts, storeResult };
}

/**
 * POST /direct-apis/t1/messages (phone_number_id in body — AiSensy Direct API)
 * Logs REQUEST, PAYLOAD, RESPONSE to direct-api.log
 */
async function sendMessageDirectApi(phoneNumberId, messagePayload, options = {}) {
  const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
  const phoneId = String(
    phoneNumberId || messagePayload?.phone_number_id || messagePayload?.phoneNumberId || ''
  ).trim();
  if (!phoneId) {
    throw new Error('phone_number_id is required for Direct API send message');
  }

  // AiSensy /messages rejects Base64 credentials ("Invalid Token!") — JWT required
  const auth = await resolveDirectApiAuthorization({ ...options, base, forceJwt: true });
  const authorization = auth.authorizationHeader;

  const isMarketing = options.isMarketing === true;
  const path = getDirectApiSendPath(isMarketing);
  const url = directApiUrl(base, path);
  let payload;
  try {
    payload = normalizeDirectApiOutboundPayload(
      {
        ...messagePayload,
        phone_number_id: phoneId,
      },
      { isMarketing }
    );
    payload.phone_number_id = phoneId;
  } catch (normalizeErr) {
    normalizeErr.statusCode = normalizeErr.statusCode || 400;
    throw normalizeErr;
  }

  const request = {
    method: 'POST',
    url,
    api: 'AiSensy Direct API',
    base,
    path,
    phoneNumberId: phoneId,
    authMode: auth.authMode,
    credentialFormat: auth.credentialFormat,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: maskBearer(authorization),
    },
  };

  logWhatsAppSend(
    isMarketing ? 'DIRECT_API_SEND_MARKETING_CALLING' : 'DIRECT_API_SEND_MESSAGE_CALLING',
    request,
    payload,
    { status: 'pending' }
  );

  const isCarouselTemplate =
    payload?.type === 'template' &&
    Array.isArray(payload?.template?.components) &&
    payload.template.components.some((c) => String(c?.type || '').toLowerCase() === 'carousel');

  const res = await axios.post(url, payload, {
    headers: {
      Accept: 'application/json, application/xml',
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    timeout: isCarouselTemplate ? 120000 : 30000,
    validateStatus: () => true,
  });

  const response = {
    status: res.status,
    statusText: res.statusText,
    data: normalizeSendResponse(res.data),
  };

  logWhatsAppSend(
    isMarketing ? 'DIRECT_API_SEND_MARKETING' : 'DIRECT_API_SEND_MESSAGE',
    request,
    payload,
    response
  );

  const normalizedData = response.data;
  const waMessageId = normalizedData?.messages?.[0]?.id;
  if (res.status < 400 && !waMessageId) {
    const errMsg =
      formatApiError(res.data, res.status) ||
      'WhatsApp API accepted the request but did not return a message id';
    const err = new Error(errMsg);
    err.statusCode = res.status || 502;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  const errMsg = formatApiError(res.data, res.status);
  if (
    res.status >= 400 &&
    /invalid token/i.test(errMsg) &&
    !options._jwtRetried
  ) {
    const accountKey = String(auth.credentialParts?.projectId || options.projectId || '').trim();
    jwtCache = { token: '', expiresAt: 0, base: '', projectId: '' };
    if (accountKey) {
      await clearStoredJwtForAccount(accountKey);
    }
    logDirectApi(
      'DIRECT_API_SEND_MESSAGE_RETRY',
      { reason: 'Invalid Token — clearing stored JWT, regenerating, retrying once', projectId: accountKey },
      null,
      { status: res.status, message: errMsg }
    );
    return sendMessageDirectApi(phoneNumberId, messagePayload, {
      ...options,
      _jwtRetried: true,
      forceJwt: true,
      skipStoredJwt: true,
      jwt: undefined,
    });
  }

  if (res.status >= 400) {
    const err = new Error(errMsg);
    err.statusCode = /waba is unverified/i.test(errMsg) ? 403 : res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  return { status: res.status, data: response.data, headers: res.headers };
}

async function resolveProbePhoneNumberId() {
  const fromEnv = String(
    process.env.AISENSY_DIRECT_API_PROBE_PHONE_NUMBER_ID ||
      process.env.WHATSAPP_PHONE_NUMBER_ID ||
      process.env.PHONE_NUMBER_ID ||
      ''
  ).trim();
  if (fromEnv) return fromEnv;

  try {
    const { WhatsAppAccount } = require('../models');
    const row = await WhatsAppAccount.findOne({
      attributes: ['phone_number_id'],
      order: [['id', 'DESC']],
    });
    return String(row?.phone_number_id || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * PATCH /direct-apis/t1/settings/update-webhook
 * AiSensy Direct API — set project webhook URL (Bearer JWT).
 * Logs REQUEST / PAYLOAD / RESPONSE to direct-api.log
 */
async function updateWebhookDirectApi(options = {}) {
  const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
  const webhookUrl = resolveDirectApiWebhookUrl(options.webhookUrl || options.url);
  const path = getUpdateWebhookPath();
  const url = directApiUrl(base, path);
  const payload = {
    webhooks: {
      url: webhookUrl,
    },
  };

  if (!webhookUrl) {
    const err = new Error(
      'Webhook URL missing. Set WEBHOOK_URL or AISENSY_DIRECT_API_WEBHOOK_URL, or pass webhookUrl'
    );
    logDirectApi('DIRECT_API_UPDATE_WEBHOOK_ERROR', { method: 'PATCH', url, base, path }, payload, {
      message: err.message,
    });
    throw err;
  }

  const auth = await resolveDirectApiAuthorization({ ...options, base, forceJwt: true });
  const authorization = auth.authorizationHeader;

  const request = {
    method: 'PATCH',
    url,
    base,
    path,
    authMode: auth.authMode,
    credentialFormat: auth.credentialFormat,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: maskBearer(authorization),
    },
  };

  logDirectApi('DIRECT_API_UPDATE_WEBHOOK_CALLING', request, payload, { status: 'pending' });

  const res = await axios.patch(url, payload, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  const response = {
    status: res.status,
    statusText: res.statusText,
    data: res.data,
  };

  logDirectApi('DIRECT_API_UPDATE_WEBHOOK', request, payload, response);

  if (res.status >= 400) {
    const err = new Error(formatApiError(res.data, res.status));
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  return { status: res.status, data: res.data, headers: res.headers, webhookUrl };
}

/**
 * GET /direct-apis/t1/get-profile
 * AiSensy Direct API — Get Business Profile Details (Bearer JWT).
 * Docs: no query/body payload — Authorization header only.
 * Response shape: { profileData: [ { about, address, description, email, profile_picture_url, websites, vertical, messaging_product } ] }
 */
async function getProfileDirectApi(options = {}) {
  const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
  const path = getProfilePath();
  const url = directApiUrl(base, path);

  const auth = await resolveDirectApiAuthorization({ ...options, base, forceJwt: true });
  const authorization = auth.authorizationHeader;

  const request = {
    method: 'GET',
    url,
    base,
    path,
    authMode: auth.authMode,
    credentialFormat: auth.credentialFormat,
    headers: {
      Accept: 'application/json',
      Authorization: maskBearer(authorization),
    },
  };

  logDirectApi('DIRECT_API_GET_PROFILE_CALLING', request, null, { status: 'pending' });

  const res = await axios.get(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  const response = {
    status: res.status,
    statusText: res.statusText,
    data: res.data,
  };

  logDirectApi('DIRECT_API_GET_PROFILE', request, null, response);

  if (res.status >= 400) {
    const err = new Error(formatApiError(res.data, res.status));
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  return { status: res.status, data: res.data, headers: res.headers };
}

/**
 * GET /direct-apis/t1/get-business-info
 * AiSensy Direct API — Get WABA Information (Bearer JWT).
 * Optional query: fields (comma-separated), e.g. id,currency,name
 * Response shape: { data: { id, account_review_status, business_verification_status, currency, ... } }
 */
async function getBusinessInfoDirectApi(options = {}) {
  const base = String(options.base || getPrimaryDirectApiBase()).replace(/\/$/, '');
  const path = getBusinessInfoPath();
  const fields = String(options.fields || '').trim();
  const url = directApiUrl(base, path);
  const params = {};
  if (fields) params.fields = fields;

  const auth = await resolveDirectApiAuthorization({ ...options, base, forceJwt: true });
  const authorization = auth.authorizationHeader;

  const request = {
    method: 'GET',
    url,
    base,
    path,
    params: fields ? { fields } : null,
    authMode: auth.authMode,
    credentialFormat: auth.credentialFormat,
    headers: {
      Accept: 'application/json',
      Authorization: maskBearer(authorization),
    },
  };

  logDirectApi('DIRECT_API_GET_BUSINESS_INFO_CALLING', request, params, { status: 'pending' });

  const res = await axios.get(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
    },
    params,
    timeout: 30000,
    validateStatus: () => true,
  });

  const response = {
    status: res.status,
    statusText: res.statusText,
    data: res.data,
  };

  logDirectApi('DIRECT_API_GET_BUSINESS_INFO', request, params, response);

  if (res.status >= 400) {
    const err = new Error(formatApiError(res.data, res.status));
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  return { status: res.status, data: res.data, headers: res.headers };
}

/** On server start: regenerate token (+ optional send) on official + self bases; full logging */
async function probeDirectApisOnStartup() {
  const enabled = String(process.env.AISENSY_DIRECT_API_STARTUP_PROBE || 'true').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'no') {
    logDirectApi('DIRECT_API_STARTUP_PROBE', { type: 'startup' }, null, { skipped: true });
    return { skipped: true };
  }

  const credentialParts = await resolveCredentialParts();
  const authMode = getDirectApiAuthMode();
  logDirectApi('DIRECT_API_STARTUP_PROBE', { type: 'startup', authMode }, null, {
    note:
      'Startup calls regenrate-token API + builds Base64 key. Send uses authMode from .env.',
    email: credentialParts.email,
    projectId: credentialParts.projectId,
  });

  const results = { bases: {}, regenerateJwt: null, authMode };

  const probeRegen = shouldProbeRegenerateToken();

  if (probeRegen) {
    const officialBase = getOfficialDirectApiBase();
    try {
      results.regenerateJwt = await regenerateTokenDirectApi({ base: officialBase, credentialParts });
      results.regenerateJwt.ok = true;
    } catch (e) {
      results.regenerateJwt = { ok: false, base: officialBase, error: e.message };
    }
  } else {
    results.regenerateJwt = { ok: false, skipped: true, reason: 'AISENSY_DIRECT_API_PROBE_REGENERATE=false' };
  }

  if (!usesJwtAuthMode()) {
    try {
      const key = await buildStaticBearer(credentialParts);
      logDirectApi(
        'DIRECT_API_STARTUP_BASE64_KEY',
        { authMode: 'base64', email: credentialParts.email, projectId: credentialParts.projectId },
        null,
        { keyPreview: key.encoded ? maskBearer(`Bearer ${key.encoded}`) : null }
      );
    } catch (_) {
      /* non-fatal */
    }
  }

  const bases = getDirectApiBasesForProbe();

  for (const { label, base } of bases) {
    results.bases[label] = { base, regenerate: null, send: null };
    if (probeRegen) {
      if (label === 'official' && results.regenerateJwt?.ok) {
        results.bases[label].regenerate = results.regenerateJwt;
      } else if (!results.regenerateJwt?.skipped) {
        try {
          results.bases[label].regenerate = await regenerateTokenDirectApi({ base, credentialParts });
          results.bases[label].regenerate.ok = true;
        } catch (e) {
          results.bases[label].regenerate = { ok: false, error: e.message };
        }
      } else {
        results.bases[label].regenerate = results.regenerateJwt;
      }
    } else {
      results.bases[label].regenerate = {
        ok: true,
        skipped: true,
        authMode: 'base64',
        note: 'No regenrate-token — Base64 key used on send',
      };
    }

    const shouldSend = String(process.env.AISENSY_DIRECT_API_STARTUP_PROBE_SEND || 'true').toLowerCase();
    if (shouldSend === '0' || shouldSend === 'false' || shouldSend === 'no') {
      results.bases[label].send = { ok: false, skipped: true, reason: 'AISENSY_DIRECT_API_STARTUP_PROBE_SEND=false' };
      continue;
    }

    const phoneId = await resolveProbePhoneNumberId();
    const toRaw = String(process.env.AISENSY_DIRECT_API_PROBE_TO || '').trim();
    const to = normalizeWhatsAppRecipient(toRaw);
    if (!phoneId) {
      results.bases[label].send = { ok: false, skipped: true, reason: 'no phone_number_id (set AISENSY_DIRECT_API_PROBE_PHONE_NUMBER_ID)' };
      logDirectApi('DIRECT_API_SEND_MESSAGE_SKIPPED', { base, label }, null, { reason: 'no phone_number_id' });
      continue;
    }
    if (!hasRecipientPhone(toRaw)) {
      results.bases[label].send = { ok: false, skipped: true, reason: 'no recipient (set AISENSY_DIRECT_API_PROBE_TO)' };
      logDirectApi('DIRECT_API_SEND_MESSAGE_SKIPPED', { base, label, phoneId }, null, {
        reason: 'no AISENSY_DIRECT_API_PROBE_TO',
        hint: 'Any format works: 9876543210, +919876543210, 919876543210',
      });
      continue;
    }

    try {
      results.bases[label].send = await sendMessageDirectApi(
        phoneId,
        {
          to,
          type: 'text',
          text: { body: `Waabizx Direct API probe ${new Date().toISOString()}` },
        },
        { base }
      );
      results.bases[label].send.ok = true;
    } catch (e) {
      results.bases[label].send = { ok: false, error: e.message };
    }
  }

  const updateWebhookFlag = String(
    process.env.AISENSY_DIRECT_API_UPDATE_WEBHOOK_ON_STARTUP ?? 'true'
  ).toLowerCase();
  const shouldUpdateWebhook =
    updateWebhookFlag !== '0' && updateWebhookFlag !== 'false' && updateWebhookFlag !== 'no';

  if (shouldUpdateWebhook && resolveDirectApiWebhookUrl()) {
    try {
      results.updateWebhook = await updateWebhookDirectApi({
        base: getOfficialDirectApiBase(),
        credentialParts,
      });
      results.updateWebhook.ok = true;
    } catch (e) {
      results.updateWebhook = { ok: false, error: e.message };
    }
  } else {
    results.updateWebhook = {
      ok: false,
      skipped: true,
      reason: shouldUpdateWebhook
        ? 'no WEBHOOK_URL / AISENSY_DIRECT_API_WEBHOOK_URL'
        : 'AISENSY_DIRECT_API_UPDATE_WEBHOOK_ON_STARTUP=false',
    };
  }

  const summary = {
    authMode,
    regenerateJwt: results.regenerateJwt?.ok ? 'TOKEN_OK' : results.regenerateJwt?.skipped ? 'SKIPPED' : 'TOKEN_FAIL',
    official: results.bases.official?.regenerate?.ok ? 'OK' : results.bases.official ? 'FAIL' : 'N/A',
    self: results.bases.self?.regenerate?.ok ? 'OK' : results.bases.self ? 'FAIL' : 'N/A',
    send: Object.values(results.bases).some((b) => b.send?.ok) ? 'OK' : 'SKIP_OR_FAIL',
    updateWebhook: results.updateWebhook?.ok
      ? 'OK'
      : results.updateWebhook?.skipped
        ? 'SKIPPED'
        : 'FAIL',
    logFile: 'backend/logs/direct-api.log',
  };

  logDirectApi('DIRECT_API_STARTUP_PROBE_DONE', { type: 'startup' }, null, summary);
  console.log('[aisensy-direct-api] startup probe:', JSON.stringify(summary));
  return results;
}

async function getCachedOrFreshJwt(base) {
  const auth = await resolveDirectApiAuthorization({
    base: base || getPrimaryDirectApiBase(),
    forceJwt: true,
  });
  return auth.authorizationHeader.replace(/^Bearer\s+/i, '');
}

function clearJwtCache() {
  jwtCache = { token: '', expiresAt: 0, base: '', projectId: '' };
}

module.exports = {
  regenerateTokenDirectApi,
  sendMessageDirectApi,
  updateWebhookDirectApi,
  getProfileDirectApi,
  getBusinessInfoDirectApi,
  getDirectApiSendPath,
  getUpdateWebhookPath,
  getProfilePath,
  getBusinessInfoPath,
  resolveDirectApiWebhookUrl,
  resolveDirectApiAuthorization,
  buildStaticBearer,
  getDirectApiAuthMode,
  usesJwtAuthMode,
  probeDirectApisOnStartup,
  getCachedOrFreshJwt,
  resolveCredentialParts,
  buildStaticBearer,
  getOfficialDirectApiBase,
  getSelfDirectApiBase,
  getPrimaryDirectApiBase,
  clearJwtCache,
  normalizeSendResponse,
  formatApiError,
};
