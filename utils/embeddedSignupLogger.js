/**
 * Embedded Signup API logger — REQUEST / PAYLOAD / RESPONSE
 * File: backend/logs/embedded-signup.log
 */
const axios = require('axios');
const logger = require('./logger');

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 4)}…${raw.slice(-4)} (len=${raw.length})`;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers || null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = String(k).toLowerCase();
    if (lower === 'authorization' || lower === 'cookie') {
      out[k] = typeof v === 'string' && v.startsWith('Bearer ')
        ? `Bearer ${maskSecret(v.slice(7))}`
        : '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeValue(value, keyHint = '') {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyHint));
  }
  if (typeof value !== 'object') {
    const lower = String(keyHint).toLowerCase();
    if (
      lower.includes('secret') ||
      lower.includes('token') ||
      lower === 'authorization' ||
      lower === 'password' ||
      lower === 'pin' ||
      lower === 'client_secret' ||
      lower === 'fb_exchange_token' ||
      lower === 'access_token'
    ) {
      return maskSecret(value);
    }
    if (lower === 'code' || lower === 'auth_code') {
      return maskSecret(value);
    }
    return value;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitizeValue(v, k);
  }
  return out;
}

/**
 * Log one Embedded Signup API hop.
 * @param {string} operation e.g. ES_GRAPH_OAUTH_SHORT_TOKEN
 * @param {object|null} request method/url/headers/params meta
 * @param {object|null} payload body (null for GET)
 * @param {object|null} response status + data / error
 */
function logEmbeddedSignupApi(operation, request, payload, response) {
  logger.embeddedSignupPayloadResponse(
    operation,
    sanitizeValue(request),
    sanitizeValue(payload),
    sanitizeValue(response)
  );
}

/**
 * Axios wrapper that always logs REQUEST / PAYLOAD / RESPONSE for Embedded Signup Graph calls.
 * Uses validateStatus: () => true so failures are still returned + logged (caller decides).
 */
async function loggedGraphRequest(operation, axiosConfig = {}) {
  const method = String(axiosConfig.method || 'get').toUpperCase();
  const url = String(axiosConfig.url || '');
  const request = {
    method,
    url,
    params: axiosConfig.params != null ? sanitizeValue(axiosConfig.params) : undefined,
    headers: sanitizeHeaders(axiosConfig.headers),
  };
  const payload =
    axiosConfig.data !== undefined ? sanitizeValue(axiosConfig.data) : null;

  const started = Date.now();
  try {
    const res = await axios({
      ...axiosConfig,
      validateStatus: () => true,
    });
    logEmbeddedSignupApi(operation, request, payload, {
      httpStatus: res.status,
      durationMs: Date.now() - started,
      data: sanitizeValue(res.data),
    });
    return res;
  } catch (err) {
    logEmbeddedSignupApi(operation, request, payload, {
      httpStatus: err?.response?.status || null,
      durationMs: Date.now() - started,
      networkError: true,
      message: err?.message || String(err),
      data: sanitizeValue(err?.response?.data),
    });
    throw err;
  }
}

module.exports = {
  logEmbeddedSignupApi,
  loggedGraphRequest,
  sanitizeValue,
  sanitizeHeaders,
  maskSecret,
};
