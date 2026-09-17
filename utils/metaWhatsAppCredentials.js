const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { logDirectApi, logWhatsAppSend, maskBearer } = require('./directApiLogger');
const { logApiFailure } = require('./logger');
const { WhatsAppAccount, ClientWhatsApp } = require('../models');
const Template = require('../models/Template');
const Project = require('../models/Project');
const { resolveTemplateBillingCategory } = require('./messageCategoryPricing');
const { normalizeMetaTemplateName, fetchMetaTemplateByName } = require('../services/metaTemplateFetchService');
const {
  tryRegisterPhoneAfterOnboarding,
  fetchCloudApiPhoneRegistrationState,
  ensureAppSubscribedToWaba,
} = require('../services/meta.service');

const getMetaTokenFromEnv = () =>
  String(
    process.env.WHATSAPP_TOKEN ||
      process.env.WA_ACCESS_TOKEN ||
      process.env.Whatsapp_Token ||
      process.env.PERMANENT_TOKEN ||
      ''
  ).trim();

const getPhoneNumberIdFromEnv = () =>
  String(
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
      process.env.PHONE_NUMBER_ID ||
      process.env.WA_PHONE_NUMBER_ID ||
      process.env.Phone_Number_ID ||
      ''
  ).trim();

const getWabaIdFromEnv = () =>
  String(process.env.WABA_ID || process.env.WHATSAPP_WABA_ID || process.env.META_WABA_ID || '').trim();

const getMetaSystemUserToken = () =>
  String(
    process.env.META_SYSTEM_USER_TOKEN ||
      process.env.AISENSY_META_SYSTEM_TOKEN ||
      ''
  ).trim();

function pickCreds(phoneNumberId, accessToken, apiVersion, source, extra = {}) {
  const pid = String(phoneNumberId || '').trim();
  const tok = String(accessToken || '').trim();
  if (!pid || !tok) return null;
  return { phoneNumberId: pid, accessToken: tok, apiVersion, source, ...extra };
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c) continue;
    const key = `${c.phoneNumberId}:${c.accessToken.slice(0, 16)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function prioritizeCandidatesByPhone(candidates, phoneNumberId) {
  const preferred = String(phoneNumberId || '').trim();
  if (!preferred) return dedupeCandidates(candidates);
  const matching = [];
  const others = [];
  for (const cred of candidates || []) {
    if (String(cred?.phoneNumberId || '') === preferred) matching.push(cred);
    else others.push(cred);
  }
  return dedupeCandidates([...matching, ...others]);
}

function filterCandidatesByPhone(candidates, phoneNumberId) {
  const preferred = String(phoneNumberId || '').trim();
  if (!preferred) return dedupeCandidates(candidates);
  const matching = (candidates || []).filter(
    (cred) => String(cred?.phoneNumberId || '') === preferred
  );
  return matching.length ? dedupeCandidates(matching) : dedupeCandidates(candidates);
}

async function fetchWabaPhoneCredentialPairs(wabaId, accessToken, apiVersion) {
  if (!wabaId || !accessToken) return [];
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(wabaId)}/phone_numbers`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { fields: 'id,display_phone_number,code_verification_status,verified_name' },
        validateStatus: () => true,
      }
    );
    if (res.status >= 400) return [];
    const phones = res.data?.data || [];
    const sorted = [...phones].sort((a, b) => {
      const av = String(a.code_verification_status || '').toUpperCase() === 'VERIFIED' ? 0 : 1;
      const bv = String(b.code_verification_status || '').toUpperCase() === 'VERIFIED' ? 0 : 1;
      return av - bv;
    });
    return sorted
      .map((p) =>
        pickCreds(p.id, accessToken, apiVersion, 'waba_phone_list', {
          wabaId,
          codeVerificationStatus: p.code_verification_status,
        })
      )
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * All credential pairs to try for sending.
 * Project onboarding rows first (correct token for selected project), .env last.
 */
async function resolveWhatsAppSendCredentialCandidates(clientId, projectId, options = {}) {
  const preferredPhoneNumberId = String(options.preferredPhoneNumberId || '').trim();
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const envPhoneNumberId = getPhoneNumberIdFromEnv();
  const envToken = getMetaTokenFromEnv();
  const envWabaId = getWabaIdFromEnv();
  const envFallback = pickCreds(envPhoneNumberId, envToken, apiVersion, 'env');

  const cid = Number(clientId);
  const pid = Number(projectId);
  const ordered = [];

  let scopedCwa = null;
  let scopedWa = null;
  let primaryToken = '';

  if (Number.isInteger(cid) && cid > 0 && Number.isInteger(pid) && pid > 0) {
    scopedWa = await WhatsAppAccount.findOne({
      where: { client_id: cid, projectId: pid },
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (scopedWa) {
      primaryToken = String(scopedWa.access_token || '').trim();
      const phoneId = String(scopedWa.phone_number_id || '').trim();
      const waba = scopedWa.waba_id;

      const systemTok = getMetaSystemUserToken();
      if (systemTok && phoneId) {
        ordered.push(
          pickCreds(phoneId, systemTok, apiVersion, 'system_user_scoped', { wabaId: waba })
        );
      }
      const envPhone = getPhoneNumberIdFromEnv();
      const envTok = getMetaTokenFromEnv();
      if (envTok && envPhone && phoneId && envPhone === phoneId) {
        ordered.push(
          pickCreds(envPhone, envTok, apiVersion, 'env_matched', { wabaId: waba })
        );
      } else if (envTok && phoneId) {
        ordered.push(
          pickCreds(phoneId, envTok, apiVersion, 'env_token_scoped_phone', { wabaId: waba })
        );
      }
      ordered.push(
        pickCreds(scopedWa.phone_number_id, scopedWa.access_token, apiVersion, 'whatsapp_accounts_scoped', {
          wabaId: waba,
        })
      );
    }

    scopedCwa = await ClientWhatsApp.findOne({
      where: { client_id: cid, project_id: pid },
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (scopedCwa) {
      const cwaToken = String(scopedCwa.access_token || primaryToken || '').trim();
      if (!primaryToken) primaryToken = cwaToken;
      ordered.push(
        pickCreds(scopedCwa.phone_number_id, cwaToken, apiVersion, 'clients_whatsapp_scoped', {
          wabaId: scopedCwa.waba_id,
        })
      );
      const cwaWabaId = String(scopedCwa.waba_id || '').trim();
      if (cwaWabaId && cwaToken && cwaWabaId !== String(scopedWa?.waba_id || '').trim()) {
        /* skip waba_phone_list — scoped phone + token only */
      }
    }

    try {
      const project = await Project.findById(pid);
      const projectPhoneId = String(project?.whatsapp_number_id || '').trim();
      const projectToken = String(
        scopedWa?.access_token || scopedCwa?.access_token || ''
      ).trim();
      if (projectPhoneId && projectToken) {
        const waPhone = String(scopedWa?.phone_number_id || scopedCwa?.phone_number_id || '').trim();
        if (!waPhone || projectPhoneId === waPhone) {
          ordered.push(
            pickCreds(projectPhoneId, projectToken, apiVersion, 'project_whatsapp_number_id', {
              wabaId: scopedWa?.waba_id || scopedCwa?.waba_id || null,
            })
          );
        }
      }
    } catch (_) {
      /* non-fatal */
    }

    const hasScoped = ordered.some((c) => c && String(c.source || '').includes('scoped'));
    if (hasScoped || preferredPhoneNumberId) {
      let scoped = dedupeCandidates(ordered);
      if (preferredPhoneNumberId) {
        const byPhone = await WhatsAppAccount.findOne({
          where: {
            client_id: cid,
            projectId: pid,
            phone_number_id: preferredPhoneNumberId,
          },
          attributes: ['phone_number_id', 'access_token', 'waba_id'],
          order: [['id', 'DESC']],
        });
        if (byPhone) {
          scoped.unshift(
            pickCreds(
              byPhone.phone_number_id,
              byPhone.access_token,
              apiVersion,
              'whatsapp_accounts_inbound_phone',
              { wabaId: byPhone.waba_id }
            )
          );
        }
        scoped = filterCandidatesByPhone(scoped, preferredPhoneNumberId);
        scoped = prioritizeCandidatesByPhone(scoped, preferredPhoneNumberId);
      } else {
        scoped = scoped.filter((c) => {
          const src = String(c?.source || '');
          return (
            src.includes('scoped') ||
            src === 'project_whatsapp_number_id' ||
            src === 'system_user_scoped' ||
            src === 'env_matched' ||
            src === 'env_token_scoped_phone'
          );
        });
        scoped = dedupeCandidates(scoped);
      }
      if (scoped.length) return scoped;
    }
  }

  let result = dedupeCandidates(ordered);
  if (preferredPhoneNumberId) {
    result = filterCandidatesByPhone(result, preferredPhoneNumberId);
    result = prioritizeCandidatesByPhone(result, preferredPhoneNumberId);
  }
  if (result.length) return result;

  if (Number.isInteger(cid) && cid > 0 && !(Number.isInteger(pid) && pid > 0)) {
    const latestWa = await WhatsAppAccount.findOne({
      where: { client_id: cid },
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (latestWa) {
      ordered.push(
        pickCreds(latestWa.phone_number_id, latestWa.access_token, apiVersion, 'whatsapp_accounts_latest', {
          wabaId: latestWa.waba_id,
        })
      );
    }

    const latestCwa = await ClientWhatsApp.findOne({
      where: { client_id: cid },
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (latestCwa) {
      ordered.push(
        pickCreds(latestCwa.phone_number_id, latestCwa.access_token, apiVersion, 'clients_whatsapp_latest', {
          wabaId: latestCwa.waba_id,
        })
      );
    }
  }

  if (envWabaId && envToken && ordered.length === 0) {
    ordered.push(...(await fetchWabaPhoneCredentialPairs(envWabaId, envToken, apiVersion)));
  }
  if (envFallback && ordered.length === 0) ordered.push(envFallback);

  result = dedupeCandidates(ordered);
  if (preferredPhoneNumberId) {
    result = filterCandidatesByPhone(result, preferredPhoneNumberId);
    result = prioritizeCandidatesByPhone(result, preferredPhoneNumberId);
  }
  return result;
}

/** Registration / platform OTP — onboarded DB tokens first, then .env. */
async function resolvePlatformOtpCredentialCandidates() {
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const ordered = [];

  try {
    const waRows = await WhatsAppAccount.findAll({
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
      limit: 25,
    });
    for (const row of waRows) {
      const tok = String(row.access_token || '').trim();
      const wabaId = String(row.waba_id || '').trim();
      if (tok && wabaId) {
        ordered.push(...(await fetchWabaPhoneCredentialPairs(wabaId, tok, apiVersion)));
      }
      ordered.push(
        pickCreds(row.phone_number_id, row.access_token, apiVersion, 'whatsapp_accounts_platform', {
          wabaId: row.waba_id,
        })
      );
    }
  } catch (e) {
    console.warn('[metaWhatsAppCredentials] platform OTP WA rows:', e?.message || e);
  }

  try {
    const cwaRows = await ClientWhatsApp.findAll({
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
      limit: 25,
    });
    for (const row of cwaRows) {
      const tok = String(row.access_token || '').trim();
      const wabaId = String(row.waba_id || '').trim();
      if (tok && wabaId) {
        ordered.push(...(await fetchWabaPhoneCredentialPairs(wabaId, tok, apiVersion)));
      }
      ordered.push(
        pickCreds(row.phone_number_id, row.access_token, apiVersion, 'clients_whatsapp_platform', {
          wabaId: row.waba_id,
        })
      );
    }
  } catch (e) {
    console.warn('[metaWhatsAppCredentials] platform OTP CWA rows:', e?.message || e);
  }

  ordered.push(...(await resolveWhatsAppSendCredentialCandidates(null, null)));
  return dedupeCandidates(ordered);
}

/** Primary credentials for sending — prefers project-linked rows. */
async function resolveWhatsAppSendCredentials(clientId, projectId) {
  const candidates = await resolveWhatsAppSendCredentialCandidates(clientId, projectId);
  if (candidates.length > 0) return candidates[0];

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  return {
    phoneNumberId: getPhoneNumberIdFromEnv(),
    accessToken: getMetaTokenFromEnv(),
    apiVersion,
    source: 'none',
  };
}

function getMetaErrorCode(err) {
  return (
    err?.response?.data?.error?.code ??
    err?.response?.data?.code ??
    (/\(#(\d+)\)/.exec(String(err?.message || '')) || [])[1]
  );
}

function isMarketingTemplateOnlyError(err) {
  const msg = String(err?.message || err?.response?.data?.message || '').toLowerCase();
  const details = String(
    err?.response?.data?.error_data?.details ||
      err?.response?.data?.error?.error_data?.details ||
      err?.response?.data?.error?.message ||
      ''
  ).toLowerCase();
  const code = Number(getMetaErrorCode(err));
  return (
    code === 131055 ||
    msg.includes('131055') ||
    details.includes('only marketing template') ||
    msg.includes('only marketing template') ||
    details.includes('marketing template message') ||
    msg.includes('marketing template message') ||
    details.includes('not supported') && msg.includes('marketing_messages')
  );
}

function isUtilityTemplateOnMarketingEndpointError(err) {
  const msg = String(err?.message || err?.response?.data?.message || '').toLowerCase();
  const details = String(
    err?.response?.data?.error_data?.details ||
      err?.response?.data?.error?.error_data?.details ||
      ''
  ).toLowerCase();
  return (
    msg.includes('utility') && msg.includes('marketing') ||
    details.includes('utility') && details.includes('marketing') ||
    msg.includes('not supported') && (msg.includes('utility') || msg.includes('authentication'))
  );
}

function isUnverifiedWabaError(err) {
  const msg = String(
    err?.message ||
      err?.response?.data?.message ||
      err?.response?.data?.error?.message ||
      (typeof err?.response?.data?.error === 'string' ? err.response.data.error : '') ||
      ''
  ).toLowerCase();
  return msg.includes('waba is unverified') || msg.includes('waba unverified');
}

function isMetaAuthError(err) {
  const code = Number(getMetaErrorCode(err));
  if (code === 190 || code === 102) return true;
  const status = Number(err?.response?.status || err?.statusCode || 0);
  if (status === 401) return true;
  const msg = String(
    err?.message ||
      err?.response?.data?.message ||
      err?.response?.data?.error?.message ||
      ''
  ).toLowerCase();
  return (
    msg.includes('authentication error') ||
    msg.includes('invalid oauth') ||
    msg.includes('session has expired') ||
    msg.includes('error validating access token')
  );
}
function isMetaPermissionError(err) {
  const code = Number(getMetaErrorCode(err));
  if (code === 10 || code === 200) return true;
  const msg = String(
    err?.message ||
      err?.response?.data?.message ||
      err?.response?.data?.error?.message ||
      ''
  ).toLowerCase();
  return (
    msg.includes('necessary permissions') ||
    msg.includes('does not have permission') ||
    msg.includes('insufficient permissions') ||
    msg.includes('(#10)')
  );
}

/** Meta blocks free-text outside the 24h customer service window (re-engagement). */
function isSessionWindowClosedError(errOrMsg) {
  const code = Number(getMetaErrorCode(errOrMsg));
  if (code === 131047) return true;
  const msg = String(
    typeof errOrMsg === 'string'
      ? errOrMsg
      : errOrMsg?.message ||
          errOrMsg?.response?.data?.message ||
          errOrMsg?.response?.data?.error?.message ||
          ''
  ).toLowerCase();
  return (
    msg.includes('re-engagement') ||
    msg.includes('reengagement') ||
    msg.includes('24 hour') ||
    msg.includes('24-hour') ||
    msg.includes('session expired') ||
    msg.includes('session is expired') ||
    msg.includes('template required') ||
    msg.includes('template message first')
  );
}

function resolveWhatsAppApiHttpStatus(err, fallbackStatus = 502) {
  if (isUnverifiedWabaError(err)) return 403;
  const status = Number(err?.statusCode || err?.response?.status || 0);
  if (status >= 400 && status < 600) return status;
  return fallbackStatus;
}

async function resolveDirectApiIsMarketing(messagePayload, hints = {}) {
  if (messagePayload?.type !== 'template' || !messagePayload?.template?.name) {
    return false;
  }

  const rawName = String(messagePayload.template.name).trim();
  const normalized = normalizeMetaTemplateName(rawName);
  const nameCandidates = [...new Set([rawName, normalized].filter(Boolean))];

  let row = null;
  try {
    const where = { name: { [Op.in]: nameCandidates } };
    const scopedProjectId = Number(hints.projectId);
    if (Number.isInteger(scopedProjectId) && scopedProjectId > 0) {
      where.projectId = scopedProjectId;
    }
    row = await Template.findOne({
      where,
      attributes: ['category', 'variables', 'metaStatus', 'metaTemplateId', 'projectId'],
      order: [['id', 'DESC']],
    });
  } catch (_) {
    row = null;
  }

  if (row) {
    const billingCat = resolveTemplateBillingCategory({
      category: row.category,
      variables: row.variables,
      metaCategory: row.variables?.metaCategory,
    });
    if (billingCat === 'marketing') return true;
    if (billingCat === 'utility' || billingCat === 'authentication' || billingCat === 'service') {
      return false;
    }
  }

  try {
    const metaTpl = await fetchMetaTemplateByName(
      normalized || rawName,
      hints.userId,
      hints.projectId
    );
    const metaCat = String(metaTpl?.category || '').toUpperCase();
    if (metaCat === 'MARKETING') return true;
    if (metaCat) return false;
  } catch (_) {
    /* ignore */
  }

  // Unknown category: use standard messages path (utility/session), not marketing-only endpoint.
  return false;
}

function isRetryableMetaCredentialError(err) {
  const code = getMetaErrorCode(err);
  const httpStatus = Number(err?.response?.status || 0);
  const type = String(err?.response?.data?.error?.type || '').toLowerCase();
  const msg = String(err?.response?.data?.error?.message || err?.message || '').toLowerCase();
  return (
    httpStatus === 403 ||
    code === 133010 ||
    code === 190 ||
    code === 10 ||
    code === 100 ||
    code === 200 ||
    type.includes('oauthexception') ||
    /auth/.test(msg) ||
    /permission/.test(msg) ||
    /not registered/.test(msg) ||
    /does not belong/.test(msg)
  );
}

async function probeWhatsAppCredential(creds) {
  if (!creds?.phoneNumberId || !creds?.accessToken) return false;
  const apiVersion = creds.apiVersion || process.env.WHATSAPP_API_VERSION || 'v22.0';
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}`,
      {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        params: { fields: 'id' },
        validateStatus: () => true,
        timeout: 5000,
      }
    );
    return res.status >= 200 && res.status < 300 && Boolean(res.data?.id);
  } catch (_) {
    return false;
  }
}

async function filterValidCredentialCandidates(candidates, maxValid = 2) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, 6);
  const valid = [];
  for (const creds of list) {
    if (valid.length >= maxValid) break;
    if (await probeWhatsAppCredential(creds)) {
      valid.push(creds);
    }
  }
  return valid;
}

/**
 * Copy a working access_token from another connected project (same WABA) when the
 * current project's token is expired or mismatched (Meta OAuth #190 / 401).
 */
async function refreshProjectWhatsAppAccessToken(clientId, projectId) {
  const cid = Number(clientId);
  const pid = Number(projectId);
  if (!Number.isInteger(cid) || cid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const account = await WhatsAppAccount.findOne({
    where: { client_id: cid, projectId: pid },
    order: [['id', 'DESC']],
  });
  if (!account) return null;

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const phoneId = String(account.phone_number_id || '').trim();
  const currentTok = String(account.access_token || '').trim();

  if (phoneId && currentTok) {
    const current = pickCreds(phoneId, currentTok, apiVersion, 'current');
    if (await probeWhatsAppCredential(current)) {
      return account;
    }
  }

  const applyToken = async (sourceRow, token, phoneNumberId) => {
    const tok = String(token || '').trim();
    const pidUse = String(phoneNumberId || phoneId || '').trim();
    if (!tok || !pidUse) return false;
    const probe = pickCreds(pidUse, tok, apiVersion, 'refresh_probe');
    if (!(await probeWhatsAppCredential(probe))) return false;
    await account.update({
      access_token: tok,
      phone_number_id: pidUse,
      ...(sourceRow?.token_expiry ? { token_expiry: sourceRow.token_expiry } : {}),
      ...(sourceRow?.waba_id ? { waba_id: sourceRow.waba_id } : {}),
      ...(sourceRow?.display_phone ? { display_phone: sourceRow.display_phone } : {}),
      status: 'connected',
      account_status: 'ACTIVE',
    });
    console.log(
      `[whatsapp-send] Refreshed access_token for project ${pid} from ${sourceRow?.projectId ?? 'token'}`
    );
    return true;
  };

  const targetWaba = String(account.waba_id || '').trim();
  const siblings = await WhatsAppAccount.findAll({
    where: { client_id: cid },
    order: [['id', 'DESC']],
  });

  for (const row of siblings) {
    if (Number(row.projectId) === pid) continue;
    if (targetWaba && String(row.waba_id || '').trim() !== targetWaba) continue;
    if (await applyToken(row, row.access_token, row.phone_number_id)) {
      return account;
    }
  }

  const envPhone = getPhoneNumberIdFromEnv();
  const envTok = getMetaTokenFromEnv();
  if (envTok && envPhone && (!phoneId || envPhone === phoneId)) {
    if (await applyToken(null, envTok, envPhone)) {
      return account;
    }
  }

  return null;
}

/** Lean credential list for registration OTP (avoids dozens of Meta API probes). */
async function resolveRegistrationOtpCredentials() {
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const ordered = [];

  ordered.push(
    pickCreds(getPhoneNumberIdFromEnv(), getMetaTokenFromEnv(), apiVersion, 'env', {
      wabaId: getWabaIdFromEnv(),
    })
  );

  try {
    const cwa = await ClientWhatsApp.findOne({
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (cwa) {
      ordered.push(
        pickCreds(cwa.phone_number_id, cwa.access_token, apiVersion, 'clients_whatsapp_registration', {
          wabaId: cwa.waba_id,
        })
      );
    }
  } catch (_) {
    /* non-fatal */
  }

  try {
    const wa = await WhatsAppAccount.findOne({
      attributes: ['phone_number_id', 'access_token', 'waba_id'],
      order: [['id', 'DESC']],
    });
    if (wa) {
      ordered.push(
        pickCreds(wa.phone_number_id, wa.access_token, apiVersion, 'whatsapp_accounts_registration', {
          wabaId: wa.waba_id,
        })
      );
    }
  } catch (_) {
    /* non-fatal */
  }

  return dedupeCandidates(ordered);
}

/** AiSensy BSP links WABA via submit-facebook-access-token — skip Graph POST .../register. */
async function ensureCredentialReadyForMessaging(creds) {
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return { ready: false, reason: 'missing_credentials' };
  }
  return { ready: true, registered: false, skippedGraphRegister: true };
}

function formatMetaApiErrorMessage(err) {
  const code = getMetaErrorCode(err);
  const msg =
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    'Unknown error';
  if (code === 133010) {
    const pinHint = process.env.META_WHATSAPP_REGISTRATION_PIN
      ? ''
      : ' Add META_WHATSAPP_REGISTRATION_PIN=your_6_digit_pin to server .env and restart the backend, or complete Cloud API registration in the app.';
    return `${msg}.${pinHint}`;
  }
  if (code === 190) {
    return `${msg}. Reconnect WhatsApp in Settings for this project — the access token does not match this phone number.`;
  }
  if (code === 131026) {
    return `${msg}. Verify the phone number is on WhatsApp (format: 91XXXXXXXXXX, no + or spaces). Ask the recipient to update WhatsApp and accept Meta terms. For marketing templates, avoid retrying the same number immediately.`;
  }
  if (code === 10 || code === 200) {
    return `${msg}. Reconnect WhatsApp from Connect WhatsApp. If this persists, confirm the Meta app is subscribed to your WhatsApp Business Account and the number is VERIFIED in Cloud API.`;
  }
  if (isUnverifiedWabaError(err)) {
    return `${msg.replace(/!+$/, '')}. Complete Meta Business Verification in Meta Business Settings → Security Center, finish WhatsApp number verification in WhatsApp Manager, then ask AiSensy support to refresh WABA status for your project.`;
  }
  return msg;
}

async function tryCloudApiRegisterAndRetry(_creds) {
  return false;
}

const AISENSY_DIRECT_API_BASE =
  String(process.env.AISENSY_DIRECT_API_BASE || 'https://backend.aisensy.com').replace(/\/$/, '');
const AISENSY_DIRECT_API_REGENERATE_PATH =
  String(
    process.env.AISENSY_DIRECT_API_REGENERATE_PATH ||
      '/direct-apis/t1/users/regenrate-token'
  ).trim() || '/direct-apis/t1/users/regenrate-token';

let aisensyDirectJwtCache = { token: '', expiresAt: 0 };

function formatAisensyDirectApiErrorBody(data, status) {
  if (typeof data === 'string' && data.trim()) return data.trim();
  const msg =
    data?.message ||
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : '');
  if (msg) return String(msg);
  return `AiSensy Direct API error (${status})`;
}

function getAisensyDirectApiCredentialPartsFromEnv() {
  const email = String(
    process.env.AISENSY_DIRECT_API_EMAIL || process.env.AISENSY_DIRECT_API_USERNAME || ''
  ).trim();
  const password = String(process.env.AISENSY_DIRECT_API_PASSWORD || '').trim();
  const projectId = String(
    process.env.AISENSY_DIRECT_API_PROJECT_ID || process.env.AISENSY_PROJECT_ID || ''
  ).trim();
  return { email, password, projectId };
}

async function resolveAisensyDirectApiCredentialParts() {
  const envParts = getAisensyDirectApiCredentialPartsFromEnv();
  if (envParts.projectId) {
    try {
      const { getDirectApiCredentialPartsForProject } = require('../services/partnerBusinessService');
      const fromDb = await getDirectApiCredentialPartsForProject(envParts.projectId);
      if (fromDb?.email && fromDb?.password && fromDb?.projectId) {
        return {
          email: fromDb.email,
          password: fromDb.password,
          projectId: String(fromDb.projectId),
          source: fromDb.source || 'partner_businesses',
        };
      }
    } catch (_) {
      /* fallback to .env */
    }
  }
  if (envParts.email && envParts.password && envParts.projectId) {
    return { ...envParts, source: 'env' };
  }
  return { ...envParts, source: 'env' };
}

async function getAisensyDirectApiStaticBearer() {
  const preset = String(
    process.env.AISENSY_DIRECT_API_STATIC_BEARER ||
      process.env.AISENSY_DIRECT_API_BEARER ||
      ''
  ).trim();
  if (preset) return preset;

  const { email, password, projectId } = await resolveAisensyDirectApiCredentialParts();
  if (!email || !password || !projectId) return '';
  return Buffer.from(`${email}:${password}:${projectId}`, 'utf8').toString('base64');
}

function extractAisensyDirectApiJwt(data) {
  if (!data || typeof data !== 'object') return '';
  const fromUsersArray = Array.isArray(data.users)
    ? data.users[0]?.token || data.users[0]?.access_token
    : '';
  return String(
    fromUsersArray ||
      data.authorizationToken ||
      data.authorization_token ||
      data.token ||
      data.access_token ||
      data.jwt ||
      data.users_token ||
      data.userToken ||
      data.usersToken ||
      data.key ||
      data?.data?.authorizationToken ||
      data?.data?.token ||
      data?.data?.access_token ||
      data?.data?.users_token ||
      data?.data?.users?.[0]?.token ||
      ''
  ).trim();
}

function extractAisensyDirectApiJwtTtlSeconds(data) {
  const raw = Number(
    data?.expiresIn || data?.expires_in || data?.ttl || data?.data?.expiresIn || data?.data?.expires_in
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

function buildAisensyDirectApiAuthError(res, credentialParts = {}) {
  const apiMsg = formatAisensyDirectApiErrorBody(res.data, res.status);
  const email = credentialParts.email || '(missing email)';
  const projectId = credentialParts.projectId || '(missing project id)';

  if (res.status === 401 && /invalid key/i.test(apiMsg)) {
    return (
      `AiSensy Direct API rejected the credential key (Invalid Key). ` +
      `The Authorization header must be Bearer BASE64(email:password:projectId). ` +
      `Check backend/.env — email=${email}, projectId=${projectId}, and AISENSY_DIRECT_API_PASSWORD. ` +
      `Confirm all three with your AiSensy partner, or set AISENSY_DIRECT_API_STATIC_BEARER if they gave you a pre-encoded key.`
    );
  }

  return apiMsg;
}

async function getAisensyDirectApiJwt() {
  const { getCachedOrFreshJwt, getPrimaryDirectApiBase } = require('../services/aisensyDirectApiClient');
  return getCachedOrFreshJwt(getPrimaryDirectApiBase());
}

function normalizeAisensyDirectApiSendResponse(data) {
  if (data?.messages?.[0]?.id) return data;
  const id =
    data?.messages?.[0]?.messageId ||
    data?.messageId ||
    data?.message_id ||
    data?.id ||
    data?.data?.messages?.[0]?.id ||
    data?.data?.messageId;
  if (id) {
    return { messaging_product: 'whatsapp', contacts: data?.contacts, messages: [{ id: String(id) }] };
  }
  return data;
}

async function resolveAisensyDirectApiSendPath(phoneNumberId, messagePayload) {
  const { getDirectApiSendPath, getPrimaryDirectApiBase } = require('../services/aisensyDirectApiClient');
  const base = getPrimaryDirectApiBase() || AISENSY_DIRECT_API_BASE;
  const isMarketing = await resolveDirectApiIsMarketing(messagePayload);
  return `${String(base).replace(/\/$/, '')}${getDirectApiSendPath(isMarketing)}`;
}

function useAisensyDirectApiForSend() {
  const forceMeta = String(process.env.FORCE_META_GRAPH_SEND || '').trim().toLowerCase();
  if (forceMeta === '1' || forceMeta === 'true' || forceMeta === 'yes') return false;
  return true;
}

function prefersMetaGraphSend() {
  if (useAisensyDirectApiForSend()) return false;
  const raw = String(
    process.env.AISENSY_DIRECT_API_USE_META_GRAPH ??
      process.env.WHATSAPP_SEND_VIA_META_GRAPH ??
      'false'
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

async function postToMetaGraphWithCreds(creds, payload) {
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    const err = new Error('WhatsApp phone_number_id and access token are required');
    err.statusCode = 400;
    throw err;
  }
  const apiVersion = creds.apiVersion || process.env.WHATSAPP_API_VERSION || 'v22.0';
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}/messages`;
  const request = {
    method: 'POST',
    url,
    api: 'Meta Graph API',
    phoneNumberId: creds.phoneNumberId,
    credentialSource: creds.source || 'unknown',
  };
  logWhatsAppSend('META_GRAPH_SEND_CALLING', request, payload, { status: 'pending' });
  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const msg =
      res.data?.error?.message ||
      res.data?.message ||
      `Meta API error (${res.status})`;
    logWhatsAppSend('META_GRAPH_SEND_ERROR', request, payload, { status: res.status, data: res.data });
    const err = new Error(msg);
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  logWhatsAppSend('META_GRAPH_SEND_OK', request, payload, { status: res.status, data: res.data });
  return {
    status: res.status,
    data: normalizeAisensyDirectApiSendResponse(res.data),
    headers: res.headers,
  };
}

/** Subscribe Meta app to WABA using every token we have (fixes #10). */
async function ensureWabaSubscribedForSend(wabaId, userAccessToken) {
  const waba = String(wabaId || '').trim();
  if (!waba) return { subscribed: false, reason: 'missing_waba' };

  const tokens = [];
  const add = (t) => {
    const s = String(t || '').trim();
    if (s && !tokens.includes(s)) tokens.push(s);
  };
  add(getMetaSystemUserToken());
  add(getMetaTokenFromEnv());
  add(userAccessToken);

  let subscribed = false;
  for (const tok of tokens) {
    try {
      const res = await ensureAppSubscribedToWaba(waba, tok);
      if (res?.subscribed) subscribed = true;
    } catch (_) {
      /* try next token */
    }
  }
  return { subscribed, wabaId: waba };
}

/** Try Meta Graph send with tokens that probe valid for this phone_number_id. */
async function postToMetaGraphWithTokenFallback(creds, payload) {
  const apiVersion = creds?.apiVersion || process.env.WHATSAPP_API_VERSION || 'v22.0';
  const phoneId = String(creds?.phoneNumberId || '').trim();

  const tokens = [];
  const addToken = (token, source) => {
    const t = String(token || '').trim();
    if (t && !tokens.some((row) => row.token === t)) {
      tokens.push({ token: t, source });
    }
  };
  // BSP / production tokens first — embedded signup user tokens often lack send permission (#10)
  addToken(getMetaSystemUserToken(), 'system_user');
  addToken(getMetaTokenFromEnv(), 'env');
  addToken(creds?.accessToken, creds?.source || 'whatsapp_accounts');

  if (creds?.wabaId) {
    await ensureWabaSubscribedForSend(creds.wabaId, creds.accessToken);
  }

  let lastError = null;
  for (const { token, source } of tokens) {
    if (!token || !phoneId) continue;
    const trustedSource =
      source === 'system_user' ||
      source === 'env' ||
      source === 'env_matched' ||
      source === 'env_configured' ||
      source === 'system_user_scoped';
    if (!trustedSource) {
      const probe = pickCreds(phoneId, token, apiVersion, source);
      if (!probe || !(await probeWhatsAppCredential(probe))) {
        continue;
      }
    }
    try {
      return await postToMetaGraphWithCreds(
        { ...creds, accessToken: token, source },
        payload
      );
    } catch (err) {
      lastError = err;
      const code = Number(getMetaErrorCode(err));
      if (code !== 10 && code !== 190 && code !== 200 && !isMetaAuthError(err)) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Meta Graph send failed: no token valid for this phone number');
}

/** Phone number id used for outbound Direct API sends (may differ from onboarded id in DB). */
function resolveOutboundPhoneNumberId(creds, options = {}) {
  const forceEnvPhoneRaw = String(process.env.AISENSY_DIRECT_API_FORCE_ENV_PHONE || 'false')
    .trim()
    .toLowerCase();
  const forceEnvPhone =
    forceEnvPhoneRaw === '1' || forceEnvPhoneRaw === 'true' || forceEnvPhoneRaw === 'yes';
  const envPhoneId = getPhoneNumberIdFromEnv();
  const onboardedPhoneId = String(creds?.phoneNumberId || '').trim();
  const preferredInboundPhone = String(options.preferredPhoneNumberId || '').trim();
  return (
    preferredInboundPhone ||
    (forceEnvPhone && envPhoneId ? envPhoneId : onboardedPhoneId || envPhoneId) ||
    null
  );
}

function collectOutboundPhoneNumberIds(credentialCandidates, options = {}) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  add(getPhoneNumberIdFromEnv());
  for (const creds of credentialCandidates || []) {
    add(creds?.phoneNumberId);
    add(resolveOutboundPhoneNumberId(creds, options));
  }
  add(options?.preferredPhoneNumberId);
  return ids;
}

async function postWithCreds(creds, templatePayload, options = {}) {
  if (!creds?.phoneNumberId) {
    throw new Error('WhatsApp phone_number_id is required for WhatsApp send.');
  }

  const {
    sendMessageDirectApi,
    getPrimaryDirectApiBase,
    getDirectApiSendPath,
  } = require('../services/aisensyDirectApiClient');
  const base = getPrimaryDirectApiBase();
  const isMarketing =
    options.isMarketing != null
      ? Boolean(options.isMarketing)
      : await resolveDirectApiIsMarketing(templatePayload, options);
  const path = getDirectApiSendPath(isMarketing);

  const localProjectId =
    options.localProjectId != null && Number(options.localProjectId) > 0
      ? Number(options.localProjectId)
      : options.projectId != null && Number(options.projectId) > 0
        ? Number(options.projectId)
        : null;

  let externalProjectId = String(options.externalProjectId || '').trim();
  if (localProjectId && options.userId) {
    try {
      const { resolveCanonicalAisensyAssistantId, findPartnerBusinessByProject } = require('../services/partnerBusinessService');
      const canonical = await resolveCanonicalAisensyAssistantId(options.userId, localProjectId);
      if (canonical) {
        externalProjectId = canonical;
      } else if (!externalProjectId) {
        const partnerRow = await findPartnerBusinessByProject(localProjectId);
        externalProjectId = String(partnerRow?.external_project_id || '').trim();
      }
    } catch (_) {
      /* non-fatal */
    }
  } else if (!externalProjectId && localProjectId) {
    try {
      const { findPartnerBusinessByProject } = require('../services/partnerBusinessService');
      const partnerRow = await findPartnerBusinessByProject(localProjectId);
      externalProjectId = String(partnerRow?.external_project_id || '').trim();
    } catch (_) {
      /* non-fatal */
    }
  }

  const envPhoneId = getPhoneNumberIdFromEnv();
  const phoneNumberId = resolveOutboundPhoneNumberId(creds, options);
  const forceEnvPhone =
    String(process.env.AISENSY_DIRECT_API_FORCE_ENV_PHONE || 'false').trim().toLowerCase() ===
      'true' ||
    String(process.env.AISENSY_DIRECT_API_FORCE_ENV_PHONE || '').trim() === '1';

  const body = {
    ...templatePayload,
    phone_number_id: phoneNumberId,
  };

  if (envPhoneId && envPhoneId !== String(creds.phoneNumberId || '')) {
    console.warn(
      `[whatsapp-send] Using phone_number_id=${phoneNumberId}` +
        (forceEnvPhone && envPhoneId === phoneNumberId
          ? ` (forced from .env; onboarded was ${creds.phoneNumberId})`
          : ` (source=${creds.source})`)
    );
  }

  logWhatsAppSend(
    'WHATSAPP_SEND_VIA_AISENSY_DIRECT_API',
    {
      api: 'AiSensy Direct API',
      phoneNumberId,
      onboardedPhoneNumberId: creds.phoneNumberId,
      credentialSource: creds.source,
      localProjectId,
      externalProjectId: externalProjectId || null,
      url: `${base}${path}`,
      path,
      isMarketing,
      authMode: process.env.AISENSY_DIRECT_API_AUTH_MODE || 'base64',
      forcedEnvPhone: Boolean(forceEnvPhone && envPhoneId && envPhoneId === phoneNumberId),
    },
    body,
    { note: 'AiSensy Direct API — JWT scoped to each project external_project_id', status: 'pending' }
  );

  return sendMessageDirectApi(phoneNumberId, body, {
    base,
    isMarketing,
    localProjectId,
    externalProjectId,
    userId: options.userId,
  });
}

/**
 * POST message payload to Meta; tries each credential pair (project onboarded token first).
 */
async function postWhatsAppMessage(credentialCandidates, messagePayload, options = {}) {
  const skipPhoneRegistrationCheck = options.skipPhoneRegistrationCheck === true;
  const graphOnly = options.graphOnly === true;
  const preferDirectApi = options.preferDirectApi === true && !graphOnly;
  const sendHints = {
    userId: options.userId,
    projectId: options.projectId,
  };

  const preferGraphFirstRaw = String(
    process.env.WHATSAPP_SEND_GRAPH_FIRST ?? 'true'
  )
    .trim()
    .toLowerCase();
  const preferGraphFirst =
    !preferDirectApi &&
    (graphOnly ||
      (preferGraphFirstRaw !== '0' &&
        preferGraphFirstRaw !== 'false' &&
        preferGraphFirstRaw !== 'no'));

  let candidates = Array.isArray(credentialCandidates) ? [...credentialCandidates] : [];

  if (options.projectId && options.userId) {
    try {
      const { ensureProjectMessagingCredentials } = require('../services/newProjectWhatsAppService');
      await ensureProjectMessagingCredentials(options.userId, options.projectId);
    } catch (prepErr) {
      console.warn('[whatsapp-send] ensureProjectMessagingCredentials:', prepErr?.message || prepErr);
    }
    try {
      await refreshProjectWhatsAppAccessToken(options.userId, options.projectId);
    } catch (refreshErr) {
      console.warn('[whatsapp-send] refreshProjectWhatsAppAccessToken:', refreshErr?.message || refreshErr);
    }
    candidates = await resolveWhatsAppSendCredentialCandidates(options.userId, options.projectId, {
      preferredPhoneNumberId: options.preferredPhoneNumberId,
    });
  } else if (options.preferredPhoneNumberId && candidates.length) {
    candidates = filterCandidatesByPhone(candidates, options.preferredPhoneNumberId);
    candidates = prioritizeCandidatesByPhone(candidates, options.preferredPhoneNumberId);
  }

  if (!graphOnly) {
    const probed = await filterValidCredentialCandidates(candidates, 4);
    if (probed.length) {
      candidates = probed;
    } else if (candidates.length) {
      candidates = candidates.slice(0, 3);
    }
  }

  const primaryCreds = candidates.find((c) => c?.wabaId && c?.phoneNumberId);
  if (primaryCreds?.wabaId) {
    try {
      await ensureWabaSubscribedForSend(primaryCreds.wabaId, primaryCreds.accessToken);
    } catch (subErr) {
      console.warn('[whatsapp-send] WABA subscribe:', subErr?.message || subErr);
    }
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const graphUrl = primaryCreds?.phoneNumberId
    ? `https://graph.facebook.com/${apiVersion}/${primaryCreds.phoneNumberId}/messages`
    : null;
  const directBase = require('../services/aisensyDirectApiClient').getPrimaryDirectApiBase();
  const directPath = require('../services/aisensyDirectApiClient').getDirectApiSendPath(false);
  logWhatsAppSend(
    'WHATSAPP_SEND_ROUTE',
    {
      graphOnly,
      preferGraphFirst,
      preferDirectApi,
      projectId: options.projectId || null,
      userId: options.userId || null,
      apisCalled: graphOnly
        ? [`Meta Graph API → ${graphUrl || '{phone_number_id}/messages'}`]
        : preferDirectApi
          ? [
              `AiSensy Direct API → ${directBase}${directPath} (first)`,
              `Meta Graph API → ${graphUrl || '{phone_number_id}/messages'} (fallback)`,
            ]
          : preferGraphFirst
            ? [
                `Meta Graph API → ${graphUrl || '{phone_number_id}/messages'} (first)`,
                `AiSensy Direct API → ${directBase}${directPath} (fallback)`,
              ]
            : [`AiSensy Direct API → ${directBase}${directPath}`, 'Meta Graph API (fallback)'],
    },
    messagePayload,
    { status: 'routing' }
  );

  let lastError = null;

  const attemptDirectApiSends = async () => {
    for (const creds of candidates) {
      if (!creds?.phoneNumberId) continue;

      if (!skipPhoneRegistrationCheck && prefersMetaGraphSend() && creds?.accessToken) {
        try {
          const state = await fetchCloudApiPhoneRegistrationState(
            creds.phoneNumberId,
            creds.accessToken
          );
          const cvs = String(state?.code_verification_status || '').toUpperCase();
          if (cvs && cvs !== 'VERIFIED') {
            await tryCloudApiRegisterAndRetry(creds);
          }
        } catch (_) {
          /* proceed */
        }
      }

      const attemptSend = async (sendOptions = {}) =>
        postWithCreds(creds, messagePayload, { ...sendHints, ...sendOptions, preferredPhoneNumberId: options.preferredPhoneNumberId });

      try {
        const response = await attemptSend();
        return { response, creds, apiVersion: creds.apiVersion };
      } catch (err) {
        lastError = err;
        const code = getMetaErrorCode(err);
        const status = err?.response?.status || err?.statusCode || 500;
        console.error(
          `Direct API send failed (source: ${creds.source}, code: ${code}):`,
          err?.response?.data || err.message
        );
        logApiFailure({
          direction: 'outbound',
          operation: 'WHATSAPP_SEND',
          method: 'POST',
          url: 'aisensy-direct-api/messages',
          status,
          message: err?.message || 'WhatsApp send failed',
          response: err?.response?.data || null,
          error: err,
        });

        if (messagePayload?.type === 'template' && isMarketingTemplateOnlyError(err)) {
          try {
            const response = await attemptSend({ isMarketing: true });
            return { response, creds, apiVersion: creds.apiVersion };
          } catch (retryErr) {
            lastError = retryErr;
          }
        }
        if (messagePayload?.type === 'template' && isUtilityTemplateOnMarketingEndpointError(err)) {
          try {
            const response = await attemptSend({ isMarketing: false });
            return { response, creds, apiVersion: creds.apiVersion };
          } catch (retryErr) {
            lastError = retryErr;
          }
        }
      }
    }
    return null;
  };

  const attemptGraphSends = async () => {
    for (const creds of candidates) {
      if (!creds?.phoneNumberId) continue;
      try {
        console.log('[whatsapp-send] Meta Graph send (source:', creds.source, graphOnly ? 'graphOnly' : '', ')');
        const graphRes = await postToMetaGraphWithTokenFallback(creds, messagePayload);
        return {
          response: { status: graphRes.status, data: graphRes.data },
          creds,
          apiVersion: creds.apiVersion,
        };
      } catch (graphErr) {
        lastError = graphErr;
        console.warn(
          '[whatsapp-send] Meta Graph failed:',
          graphErr?.response?.data || graphErr.message
        );
      }
    }
    return null;
  };

  if (preferDirectApi && candidates.length && useAisensyDirectApiForSend()) {
    const directResult = await attemptDirectApiSends();
    if (directResult) return directResult;
    const graphResult = await attemptGraphSends();
    if (graphResult) return graphResult;
    const e = lastError || new Error('WhatsApp send failed via Direct API and Meta Graph');
    e.metaMessage = formatMetaApiErrorMessage(e);
    throw e;
  }

  if (preferGraphFirst && candidates.length) {
    const graphResult = await attemptGraphSends();
    if (graphResult) return graphResult;
    if (graphOnly) {
      const e = lastError || new Error('Meta Graph send failed');
      e.metaMessage = formatMetaApiErrorMessage(e);
      throw e;
    }
  }

  let wabaSubscribeAttempted = Boolean(primaryCreds);

  for (const creds of candidates) {
    if (!creds?.phoneNumberId) continue;

    if (!skipPhoneRegistrationCheck && prefersMetaGraphSend() && creds?.accessToken) {
      try {
        const state = await fetchCloudApiPhoneRegistrationState(
          creds.phoneNumberId,
          creds.accessToken
        );
        const cvs = String(state?.code_verification_status || '').toUpperCase();
        if (cvs && cvs !== 'VERIFIED') {
          await tryCloudApiRegisterAndRetry(creds);
        }
      } catch (_) {
        /* proceed to send attempt */
      }
    }

    const attemptSend = async (sendOptions = {}) =>
      postWithCreds(creds, messagePayload, {
        ...sendHints,
        ...sendOptions,
        preferredPhoneNumberId: options.preferredPhoneNumberId,
      });

    try {
      const response = await attemptSend();
      return { response, creds, apiVersion: creds.apiVersion };
    } catch (err) {
      lastError = err;
      const code = getMetaErrorCode(err);
      const status = err?.response?.status || err?.statusCode || 500;
      console.error(
        `Meta message send failed (source: ${creds.source}, code: ${code}):`,
        err?.response?.data || err.message
      );
      logApiFailure({
        direction: 'outbound',
        operation: 'WHATSAPP_SEND',
        method: 'POST',
        url: 'aisensy-direct-api/messages',
        status,
        message: err?.message || 'WhatsApp send failed',
        response: err?.response?.data || null,
        error: err,
      });

      if (messagePayload?.type === 'template' && isMarketingTemplateOnlyError(err)) {
        try {
          console.log('Retrying MARKETING template via /marketing_messages path');
          const response = await attemptSend({ isMarketing: true });
          return { response, creds, apiVersion: creds.apiVersion };
        } catch (retryErr) {
          lastError = retryErr;
          console.error(
            'Template retry on marketing_messages path failed:',
            retryErr?.response?.data || retryErr.message
          );
        }
      }

      if (messagePayload?.type === 'template' && isUtilityTemplateOnMarketingEndpointError(err)) {
        try {
          console.log('Retrying UTILITY template via /messages path');
          const response = await attemptSend({ isMarketing: false });
          return { response, creds, apiVersion: creds.apiVersion };
        } catch (retryErr) {
          lastError = retryErr;
          console.error(
            'Template retry on standard messages path failed:',
            retryErr?.response?.data || retryErr.message
          );
        }
      }

      // AiSensy Direct API permission/unverified errors — fall back to Meta Graph when we have a token.
      if (
        creds?.accessToken &&
        (isUnverifiedWabaError(lastError) ||
          isMetaPermissionError(lastError) ||
          isMetaAuthError(lastError) ||
          !useAisensyDirectApiForSend())
      ) {
        try {
          const reason = isUnverifiedWabaError(lastError)
            ? 'AiSensy WABA unverified'
            : isMetaAuthError(lastError)
              ? 'Meta auth error (#190/401)'
            : isMetaPermissionError(lastError)
              ? 'AiSensy/Meta permission error (#10)'
              : 'FORCE_META_GRAPH_SEND';
          console.log(`Retrying send via Meta Graph API (${reason})`);
          const graphRes = await postToMetaGraphWithTokenFallback(creds, messagePayload);
          return {
            response: { status: graphRes.status, data: graphRes.data },
            creds,
            apiVersion: creds.apiVersion,
          };
        } catch (graphErr) {
          lastError = graphErr;
          console.error(
            'Meta Graph send fallback failed:',
            graphErr?.response?.data || graphErr.message
          );
        }
      }

      if (code === 133010) {
        const registered = await tryCloudApiRegisterAndRetry(creds);
        if (registered) {
          try {
            const response = await attemptSend();
            return { response, creds, apiVersion: creds.apiVersion };
          } catch (retryErr) {
            lastError = retryErr;
            console.error(
              `Meta retry after register failed (source: ${creds.source}):`,
              retryErr?.response?.data || retryErr.message
            );
          }
        }
      }

      if (code === 10 && creds.wabaId) {
        const sub = await ensureAppSubscribedToWaba(creds.wabaId, creds.accessToken);
        if (sub.subscribed) {
          try {
            const response = await attemptSend();
            return { response, creds, apiVersion: creds.apiVersion };
          } catch (retryErr) {
            lastError = retryErr;
            console.error(
              `Meta retry after WABA subscribe failed (source: ${creds.source}):`,
              retryErr?.response?.data || retryErr.message
            );
          }
        }
      }

      if (!isRetryableMetaCredentialError(lastError)) break;
    }
  }

  const e = lastError || new Error('WhatsApp send failed: no valid credentials');
  e.metaMessage = lastError?.message || formatMetaApiErrorMessage(e);
  throw e;
}

/** @deprecated alias — use postWhatsAppMessage */
async function postWhatsAppTemplateMessage(credentialCandidates, templatePayload, options = {}) {
  return postWhatsAppMessage(credentialCandidates, templatePayload, options);
}

module.exports = {
  resolveWhatsAppSendCredentials,
  resolveWhatsAppSendCredentialCandidates,
  prioritizeCandidatesByPhone,
  filterCandidatesByPhone,
  resolvePlatformOtpCredentialCandidates,
  resolveRegistrationOtpCredentials,
  ensureCredentialReadyForMessaging,
  filterValidCredentialCandidates,
  probeWhatsAppCredential,
  postWhatsAppMessage,
  postWhatsAppTemplateMessage,
  formatMetaApiErrorMessage,
  isRetryableMetaCredentialError,
  isUnverifiedWabaError,
  isSessionWindowClosedError,
  resolveWhatsAppApiHttpStatus,
  refreshProjectWhatsAppAccessToken,
  getMetaTokenFromEnv,
  getMetaSystemUserToken,
  getPhoneNumberIdFromEnv,
  getWabaIdFromEnv,
  resolveOutboundPhoneNumberId,
  collectOutboundPhoneNumberIds,
};
