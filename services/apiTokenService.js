const crypto = require('crypto');
const db = require('../config/db');

function generateApiToken() {
  const randomPart = crypto.randomBytes(18).toString('base64url');
  return `wz_live_${randomPart}`;
}

function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function validateIpv4(ip) {
  const raw = String(ip || '').trim();
  if (!raw) {
    return { ok: false, message: 'IP address is required.' };
  }

  const parts = raw.split('.');
  if (parts.length !== 4) {
    return {
      ok: false,
      message: 'Enter a valid IPv4 address (example: 103.25.100.20).',
    };
  }

  const valid = parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255;
  });

  if (!valid) {
    return {
      ok: false,
      message: 'Each IP segment must be a number between 0 and 255.',
    };
  }

  return { ok: true, value: raw };
}

function validateDomainUrl(domain) {
  const raw = String(domain || '').trim();
  if (!raw) {
    return { ok: false, message: 'Domain is required.' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      message: 'Enter a valid domain URL (example: https://mycrm.com).',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      message: 'Domain must start with http:// or https://.',
    };
  }

  if (!parsed.hostname || parsed.hostname.length < 3) {
    return {
      ok: false,
      message: 'Enter a valid domain hostname (example: https://mycrm.com).',
    };
  }

  return { ok: true, value: raw };
}

function normalizeDomainOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase().replace(/\/$/, '');
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
}

function resolveRequestOrigin(req) {
  const headerOrigin = String(req.headers.origin || req.headers.Origin || '').trim();
  if (headerOrigin) return headerOrigin.replace(/\/$/, '');

  const referer = String(req.headers.referer || req.headers.Referer || '').trim();
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function originsMatch(requestOrigin, allowedDomain) {
  if (!requestOrigin || !allowedDomain) return false;
  return normalizeDomainOrigin(requestOrigin) === normalizeDomainOrigin(allowedDomain);
}

function ipsMatch(requestIp, allowedIp) {
  const left = String(requestIp || '').trim();
  const right = String(allowedIp || '').trim();
  if (!left || !right) return false;
  return left === right;
}

async function isProjectWhatsAppConnected(projectId) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const [rows] = await db.query(
    `SELECT id
     FROM whatsapp_accounts
     WHERE projectId = ?
       AND TRIM(COALESCE(waba_id, '')) <> ''
       AND TRIM(COALESCE(phone_number_id, '')) <> ''
       AND TRIM(COALESCE(access_token, '')) <> ''
     LIMIT 1`,
    [pid]
  );

  return Array.isArray(rows) && rows.length > 0;
}

module.exports = {
  generateApiToken,
  hashApiToken,
  validateIpv4,
  validateDomainUrl,
  normalizeDomainOrigin,
  resolveRequestOrigin,
  originsMatch,
  ipsMatch,
  isProjectWhatsAppConnected,
};
