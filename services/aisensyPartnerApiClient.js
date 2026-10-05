const axios = require('axios');
const { logPartnerApi } = require('../utils/partnerApiLogger');

function getPartnerApiBase() {
  return String(
    process.env.AISENSY_PARTNER_API_BASE || 'https://apis.aisensy.com/partner-apis/v1'
  ).replace(/\/$/, '');
}

function getPartnerId() {
  return String(process.env.AISENSY_PARTNER_ID || process.env.PARTNER_ID || '').trim();
}

function getPartnerApiKey() {
  return String(
    process.env.AISENSY_PARTNER_API_KEY ||
      process.env.X_AISENSY_PARTNER_API_KEY ||
      process.env.PARTNER_API_KEY ||
      ''
  ).trim();
}

function partnerHeaders() {
  const key = getPartnerApiKey();
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-AiSensy-Partner-API-Key': key,
  };
}

function partnerUrl(path) {
  const base = getPartnerApiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

function firstBusinessIdFromList(listResponse) {
  const data = listResponse?.data;
  if (!data) return null;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const first = rows[0];
  return first?.id || first?.business_id || null;
}

async function aisensyPartnerRequest(operation, method, path, body = null) {
  const partnerId = getPartnerId();
  const url = partnerUrl(path);
  const request = {
    method: method.toUpperCase(),
    url,
    partnerId,
    base: getPartnerApiBase(),
    path,
    headers: partnerHeaders(),
  };
  const payload = body || null;

  if (!getPartnerApiKey()) {
    const err = new Error('AISENSY_PARTNER_API_KEY is not set in backend/.env');
    err.statusCode = 500;
    logPartnerApi(`${operation}_ERROR`, request, payload, { message: err.message });
    throw err;
  }
  if (!partnerId) {
    const err = new Error('AISENSY_PARTNER_ID is not set in backend/.env');
    err.statusCode = 500;
    logPartnerApi(`${operation}_ERROR`, request, payload, { message: err.message });
    throw err;
  }

  logPartnerApi(`${operation}_CALLING`, request, payload, { status: 'pending' });

  try {
    const res = await axios({
      method: method.toLowerCase(),
      url,
      data: body || undefined,
      headers: partnerHeaders(),
      timeout: 30000,
      validateStatus: () => true,
    });

    const response = {
      status: res.status,
      statusText: res.statusText,
      headers: {
        'content-type': res.headers?.['content-type'],
        'apigw-requestid': res.headers?.['apigw-requestid'],
      },
      data: res.data,
    };

    logPartnerApi(operation, request, payload, response);

    if (res.status >= 400) {
      const msg =
        res.data?.message ||
        res.data?.error?.message ||
        (typeof res.data?.error === 'string' ? res.data.error : '') ||
        `AiSensy Partner API error (${res.status})`;
      const err = new Error(msg);
      err.statusCode = res.status;
      err.response = { status: res.status, data: res.data };
      throw err;
    }

    return { status: res.status, data: res.data, headers: res.headers };
  } catch (error) {
    if (!error.response && !error.statusCode) {
      logPartnerApi(`${operation}_NETWORK_ERROR`, request, payload, {
        message: error.message,
        code: error.code,
      });
    }
    throw error;
  }
}

/** POST partner/{partner_id}/business */
async function createBusinessExternal(payload, partnerId = null) {
  const pid = partnerId || getPartnerId();
  return aisensyPartnerRequest(
    'AISENSY_PARTNER_POST_BUSINESS',
    'POST',
    `/partner/${encodeURIComponent(pid)}/business`,
    payload
  );
}

/** GET partner/{partner_id}/business */
async function listBusinessesExternal(partnerId = null) {
  const pid = partnerId || getPartnerId();
  return aisensyPartnerRequest(
    'AISENSY_PARTNER_GET_BUSINESS_LIST',
    'GET',
    `/partner/${encodeURIComponent(pid)}/business`
  );
}

/** GET partner/{partner_id}/business/{business_id} */
async function getBusinessExternal(businessId, partnerId = null) {
  const pid = partnerId || getPartnerId();
  const bid = String(businessId || '').trim();
  return aisensyPartnerRequest(
    'AISENSY_PARTNER_GET_BUSINESS',
    'GET',
    `/partner/${encodeURIComponent(pid)}/business/${encodeURIComponent(bid)}`
  );
}

function shouldCallPostOnStartup() {
  const raw = String(process.env.AISENSY_PARTNER_STARTUP_PROBE_POST ?? 'true').toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

/**
 * On every server start: calls all 3 Partner APIs and logs to backend/logs/partner-api.log
 * 1) GET list  2) GET one  3) POST create (unique probe email unless disabled)
 */
async function probePartnerApisOnStartup() {
  const enabled = String(process.env.AISENSY_PARTNER_STARTUP_PROBE || 'true').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'no') {
    logPartnerApi('AISENSY_PARTNER_STARTUP_PROBE', { type: 'startup' }, null, { enabled: false, skipped: true });
    return { skipped: true };
  }

  const partnerId = getPartnerId();
  logPartnerApi('AISENSY_PARTNER_STARTUP_PROBE', { type: 'startup', partnerId }, null, {
    note: 'calling all 3 APIs',
  });

  const results = { partnerId, apis: {} };

  // API 1 — GET list (502 from AiSensy is non-fatal on startup)
  try {
    results.apis.list = await listBusinessesExternal();
    results.apis.list.ok = true;
  } catch (e) {
    const status = Number(e.statusCode) || 0;
    results.apis.list = {
      ok: false,
      error: e.message,
      status,
      note: status >= 500 ? 'AiSensy Partner API unavailable — using local partner_businesses when needed' : undefined,
    };
  }

  // API 2 — GET one business
  const probeBusinessId =
    String(process.env.AISENSY_PARTNER_PROBE_BUSINESS_ID || '').trim() ||
    firstBusinessIdFromList(results.apis.list);
  if (probeBusinessId) {
    try {
      results.apis.get = await getBusinessExternal(probeBusinessId);
      results.apis.get.ok = true;
      results.apis.get.businessId = probeBusinessId;
    } catch (e) {
      results.apis.get = { ok: false, businessId: probeBusinessId, error: e.message };
    }
  } else {
    results.apis.get = { ok: false, skipped: true, reason: 'no business id (list empty or failed)' };
    logPartnerApi('AISENSY_PARTNER_GET_BUSINESS_SKIPPED', { type: 'startup', partnerId }, null, {
      reason: 'no business id',
    });
  }

  // API 3 — POST create business
  if (shouldCallPostOnStartup()) {
    const stamp = Date.now();
    const createBody = {
      display_name: `Waabizx Server Probe ${stamp}`,
      email: `waabizx-server-probe-${stamp}@probe.local`,
      password: `Probe${stamp}!`,
      company: 'Waabizx Server Probe',
      contact: '919876543210',
      currency: 'INR',
      timezone: 'Asia/Calcutta GMT+05:30',
    };
    try {
      results.apis.create = await createBusinessExternal(createBody);
      results.apis.create.ok = true;
    } catch (e) {
      results.apis.create = { ok: false, error: e.message };
    }
  } else {
    results.apis.create = { ok: false, skipped: true, reason: 'AISENSY_PARTNER_STARTUP_PROBE_POST=false' };
    logPartnerApi('AISENSY_PARTNER_POST_BUSINESS_SKIPPED', { type: 'startup', partnerId }, null, {
      reason: 'startup POST disabled',
    });
  }

  const summary = {
    list: results.apis.list?.ok ? 'OK' : 'FAIL',
    get: results.apis.get?.ok ? 'OK' : results.apis.get?.skipped ? 'SKIPPED' : 'FAIL',
    create: results.apis.create?.ok ? 'OK' : results.apis.create?.skipped ? 'SKIPPED' : 'FAIL',
    logFile: 'backend/logs/partner-api.log',
  };

  logPartnerApi('AISENSY_PARTNER_STARTUP_PROBE_DONE', { type: 'startup', partnerId }, null, summary);
  console.log('[aisensy-partner] startup probe:', JSON.stringify(summary));
  return results;
}

function useExternalPartnerApi() {
  const raw = String(process.env.AISENSY_PARTNER_MODE || 'both').trim().toLowerCase();
  return raw === 'external' || raw === 'both' || raw === 'aisensy';
}

module.exports = {
  getPartnerApiBase,
  getPartnerId,
  getPartnerApiKey,
  createBusinessExternal,
  listBusinessesExternal,
  getBusinessExternal,
  probePartnerApisOnStartup,
  useExternalPartnerApi,
  aisensyPartnerRequest,
};
