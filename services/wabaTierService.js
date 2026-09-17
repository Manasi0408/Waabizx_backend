const axios = require('axios');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { resolveWhatsAppAccountCreds } = require('./metaProfileService');

const META_API_VERSION =
  String(
    process.env.WHATSAPP_API_VERSION ||
      process.env.META_API_VERSION ||
      process.env.META_GRAPH_API_VERSION ||
      'v23.0'
  ).trim() || 'v23.0';

const TIER_LIMIT_MAP = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: null,
};

const TIER_LABEL_MAP = {
  TIER_50: 'Tier 50',
  TIER_250: 'Tier 250',
  TIER_1K: 'Tier 1K',
  TIER_2K: 'Tier 2K',
  TIER_10K: 'Tier 10K',
  TIER_100K: 'Tier 100K',
  TIER_UNLIMITED: 'Unlimited',
};

const CACHE_MS = 60 * 1000;
const tierCache = new Map();

function graphBase() {
  return `https://graph.facebook.com/${META_API_VERSION}`;
}

function normalizeTierKey(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  if (!s) return null;
  if (TIER_LIMIT_MAP[s] !== undefined) return s;
  if (s.includes('UNLIMITED')) return 'TIER_UNLIMITED';
  const num = parseInt(s.replace(/\D/g, ''), 10);
  if (num === 50) return 'TIER_50';
  if (num === 250) return 'TIER_250';
  if (num === 1000) return 'TIER_1K';
  if (num === 2000) return 'TIER_2K';
  if (num === 10000) return 'TIER_10K';
  if (num === 100000) return 'TIER_100K';
  return s.startsWith('TIER_') ? s : null;
}

function tierToDailyLimit(tierKey) {
  const key = normalizeTierKey(tierKey);
  if (!key) return null;
  const val = TIER_LIMIT_MAP[key];
  if (val === null) return 1000000;
  return val ?? null;
}

function tierToLabel(tierKey) {
  const key = normalizeTierKey(tierKey);
  return (key && TIER_LABEL_MAP[key]) || tierKey || 'Unknown';
}

function formatMessagingLimitDisplay(dailyLimit, tierKey) {
  const key = normalizeTierKey(tierKey);
  if (key === 'TIER_UNLIMITED') return 'Unlimited';
  const limit = Number(dailyLimit);
  if (Number.isFinite(limit) && limit >= 1000000) return 'Unlimited';
  if (Number.isFinite(limit) && limit > 0) {
    return limit.toLocaleString('en-IN');
  }
  return null;
}

function parseThroughputLevel(throughput) {
  if (!throughput) return null;
  if (typeof throughput === 'string') return throughput;
  return throughput.level || throughput.throughput_level || null;
}

async function graphGet(path, accessToken, params = {}) {
  const res = await axios.get(`${graphBase()}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    timeout: 15000,
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

async function fetchPhoneTierFields(phoneNumberId, accessToken) {
  const fieldSets = [
    'id,display_phone_number,quality_rating,throughput,messaging_limit_tier',
    'id,display_phone_number,quality_rating,throughput',
    'id,quality_rating,throughput,messaging_limit_tier',
    'id,quality_rating,throughput',
  ];

  let lastErr = null;
  for (const fields of fieldSets) {
    try {
      return await graphGet(encodeURIComponent(phoneNumberId), accessToken, { fields });
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return {};
}

async function fetchWabaPhoneTier(wabaId, phoneNumberId, accessToken) {
  if (!wabaId || !accessToken) return null;
  try {
    const data = await graphGet(
      `${encodeURIComponent(wabaId)}/phone_numbers`,
      accessToken,
      {
        fields: 'id,messaging_limit_tier,quality_rating,throughput',
      }
    );
    const rows = Array.isArray(data?.data) ? data.data : [];
    const hit =
      rows.find((r) => String(r.id) === String(phoneNumberId)) ||
      rows[0] ||
      null;
    return hit;
  } catch {
    return null;
  }
}

async function resolveCredentials(projectId, userId = null) {
  const pid = Number(projectId);
  const uid = Number(userId);
  if (Number.isInteger(uid) && uid > 0 && Number.isInteger(pid) && pid > 0) {
    const creds = await resolveWhatsAppAccountCreds(uid, pid);
    if (creds?.phoneNumberId && creds?.accessToken) {
      return creds;
    }
  }

  const account = await WhatsAppAccount.findOne({
    where: { projectId: pid },
    order: [['id', 'DESC']],
  });

  const phoneNumberId = String(account?.phone_number_id || '').trim();
  const accessToken = String(account?.access_token || '').trim();
  const wabaId = String(account?.waba_id || '').trim();
  if (phoneNumberId && accessToken) {
    return { phoneNumberId, accessToken, wabaId, source: 'whatsapp_accounts_model' };
  }
  return null;
}

/**
 * Resolve WABA messaging tier + throughput from Meta Graph API (cached per project).
 */
async function getWabaTierForProject(projectId, userId = null) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      tier: null,
      tierLabel: 'Not linked',
      messagingLimitDisplay: null,
      dailyMessagingLimit: null,
      throughputLevel: null,
      qualityRating: null,
      source: 'none',
      fetchedAt: new Date().toISOString(),
    };
  }

  const cacheKey = `${pid}:${Number(userId) || 0}`;
  const cached = tierCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const creds = await resolveCredentials(pid, userId);
  const phoneNumberId = String(creds?.phoneNumberId || '').trim();
  const accessToken = String(creds?.accessToken || '').trim();
  const wabaId = String(creds?.wabaId || '').trim();

  if (!phoneNumberId || !accessToken) {
    const fallback = {
      tier: null,
      tierLabel: 'WhatsApp not linked',
      messagingLimitDisplay: null,
      dailyMessagingLimit: null,
      throughputLevel: null,
      qualityRating: null,
      source: 'local',
      fetchedAt: new Date().toISOString(),
    };
    tierCache.set(cacheKey, { data: fallback, expiresAt: Date.now() + CACHE_MS });
    return fallback;
  }

  try {
    const [phoneRow, wabaPhoneRow] = await Promise.all([
      fetchPhoneTierFields(phoneNumberId, accessToken),
      fetchWabaPhoneTier(wabaId, phoneNumberId, accessToken),
    ]);

    const tierRaw =
      phoneRow?.messaging_limit_tier ||
      wabaPhoneRow?.messaging_limit_tier ||
      null;
    const tierKey = normalizeTierKey(tierRaw);
    const throughputLevel =
      parseThroughputLevel(phoneRow?.throughput) ||
      parseThroughputLevel(wabaPhoneRow?.throughput);
    const qualityRating =
      phoneRow?.quality_rating || wabaPhoneRow?.quality_rating || null;
    const dailyMessagingLimit = tierToDailyLimit(tierKey || tierRaw);
    const messagingLimitDisplay = formatMessagingLimitDisplay(
      dailyMessagingLimit,
      tierKey || tierRaw
    );

    const result = {
      tier: tierKey || tierRaw || null,
      tierLabel: messagingLimitDisplay || tierToLabel(tierKey || tierRaw),
      messagingLimitDisplay,
      dailyMessagingLimit,
      throughputLevel: throughputLevel || null,
      qualityRating: qualityRating || null,
      displayPhoneNumber: phoneRow?.display_phone_number || null,
      source: tierKey || tierRaw ? 'meta_graph' : 'meta_graph_partial',
      fetchedAt: new Date().toISOString(),
    };

    tierCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_MS });
    return result;
  } catch (err) {
    console.warn('[WABA tier] Graph fetch failed', {
      projectId: pid,
      message: err?.message || err,
    });
    const fallback = {
      tier: null,
      tierLabel: 'Unavailable',
      messagingLimitDisplay: null,
      dailyMessagingLimit: null,
      throughputLevel: null,
      qualityRating: null,
      source: 'error',
      graphError: err?.message || 'Graph API error',
      fetchedAt: new Date().toISOString(),
    };
    tierCache.set(cacheKey, { data: fallback, expiresAt: Date.now() + 15 * 1000 });
    return fallback;
  }
}

function clearWabaTierCache(projectId) {
  if (projectId != null) {
    const pid = Number(projectId);
    for (const key of tierCache.keys()) {
      if (String(key).startsWith(`${pid}:`)) tierCache.delete(key);
    }
    return;
  }
  tierCache.clear();
}

module.exports = {
  getWabaTierForProject,
  clearWabaTierCache,
  tierToDailyLimit,
  tierToLabel,
  formatMessagingLimitDisplay,
  TIER_LIMIT_MAP,
};
