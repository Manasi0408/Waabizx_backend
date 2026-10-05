const PlatformSetting = require('../models/PlatformSetting');

const SETTING_KEY = 'conversation_metrics';

const DEFAULT_METRICS = {
  marketing: { label: 'Marketing', rate: 0.95, rate_usd: 0.012 },
  utility: { label: 'Utility', rate: 0.15, rate_usd: 0.002 },
  authentication: { label: 'Authentication', rate: 0.129, rate_usd: 0.0016 },
  service: { label: 'Service', rate: 0, rate_usd: 0, text: 'Free up to 10 agents' },
};

const METRIC_KEYS = ['marketing', 'utility', 'authentication', 'service'];

let cachedConfig = null;
let cachedRates = null;

const cloneDefaults = () =>
  METRIC_KEYS.reduce((acc, key) => {
    acc[key] = { ...DEFAULT_METRICS[key] };
    return acc;
  }, {});

const parseStoredConfig = (raw) => {
  if (!raw) return cloneDefaults();
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return cloneDefaults();
    const merged = cloneDefaults();
    for (const key of METRIC_KEYS) {
      if (parsed[key] && typeof parsed[key] === 'object') {
        merged[key] = { ...merged[key], ...parsed[key] };
      }
    }
    return merged;
  } catch {
    return cloneDefaults();
  }
};

const formatRateText = (rate, currency = 'INR') => {
  const n = Math.max(0, Number(rate) || 0);
  const formatted = Number.isInteger(n) ? String(n) : String(n);
  if (String(currency).toUpperCase() === 'USD') {
    return `$${formatted} /msg`;
  }
  return `Rs. ${formatted} /msg`;
};

const buildPublicPayload = (config, currency = 'INR') => {
  const resolvedCurrency = String(currency).toUpperCase() === 'USD' ? 'USD' : 'INR';
  const rates = {};
  const metrics = METRIC_KEYS.map((key) => {
    const item = config[key] || DEFAULT_METRICS[key];
    const rate =
      resolvedCurrency === 'USD'
        ? Math.max(0, Number(item.rate_usd ?? item.rate) || 0)
        : Math.max(0, Number(item.rate) || 0);
    rates[key] = rate;
    const text =
      key === 'service' && item.text != null && String(item.text).trim()
        ? String(item.text).trim()
        : formatRateText(rate, resolvedCurrency);
    return {
      key,
      label: item.label || DEFAULT_METRICS[key].label,
      rate,
      text,
      ...(resolvedCurrency === 'USD' ? { rate_usd: rate } : {}),
    };
  });
  return { metrics, rates, currency: resolvedCurrency };
};

const refreshCache = (config) => {
  cachedConfig = config;
  cachedRates = buildPublicPayload(config).rates;
};

const loadConfig = async () => {
  if (cachedConfig) return cachedConfig;
  try {
    const row = await PlatformSetting.findOne({ where: { key: SETTING_KEY } });
    const config = parseStoredConfig(row?.value);
    refreshCache(config);
    if (!row) {
      await PlatformSetting.create({
        key: SETTING_KEY,
        value: JSON.stringify(config),
      });
    }
    return config;
  } catch {
    const config = cloneDefaults();
    refreshCache(config);
    return config;
  }
};

const invalidateCache = () => {
  cachedConfig = null;
  cachedRates = null;
};

const normalizeUpdates = (body = {}) => {
  const current = cachedConfig || cloneDefaults();
  const next = cloneDefaults();

  for (const key of METRIC_KEYS) {
    const incoming = body[key];
    const base = current[key] || DEFAULT_METRICS[key];
    if (incoming && typeof incoming === 'object') {
      next[key] = {
        label: incoming.label != null ? String(incoming.label).trim() || base.label : base.label,
        rate:
          incoming.rate != null
            ? Math.max(0, Number(incoming.rate) || 0)
            : Math.max(0, Number(base.rate) || 0),
        rate_usd:
          incoming.rate_usd != null
            ? Math.max(0, Number(incoming.rate_usd) || 0)
            : Math.max(0, Number(base.rate_usd ?? DEFAULT_METRICS[key]?.rate_usd) || 0),
        ...(key === 'service'
          ? {
              text:
                incoming.text != null
                  ? String(incoming.text).trim() || base.text
                  : base.text,
            }
          : {}),
      };
    } else {
      next[key] = { ...base };
    }
  }

  return next;
};

async function ensureConversationMetricsLoaded() {
  return loadConfig();
}

async function getPublicConversationMetrics(currency = 'INR') {
  const config = await loadConfig();
  return buildPublicPayload(config, currency);
}

function getCachedMessageRates() {
  if (cachedRates) return cachedRates;
  return buildPublicPayload(cloneDefaults()).rates;
}

function getMessageRateForCategory(category) {
  const key = String(category || 'marketing').toLowerCase();
  const rates = getCachedMessageRates();
  return rates[key] ?? rates.marketing ?? DEFAULT_METRICS.marketing.rate;
}

async function updateConversationMetrics(body) {
  await loadConfig();
  const next = normalizeUpdates(body);
  await PlatformSetting.upsert({
    key: SETTING_KEY,
    value: JSON.stringify(next),
  });
  refreshCache(next);
  return {
    ...buildPublicPayload(next),
    config: next,
  };
}

async function getAdminConversationMetrics() {
  const config = await loadConfig();
  return {
    config,
    ...buildPublicPayload(config),
  };
}

module.exports = {
  DEFAULT_METRICS,
  METRIC_KEYS,
  ensureConversationMetricsLoaded,
  getPublicConversationMetrics,
  getAdminConversationMetrics,
  updateConversationMetrics,
  getCachedMessageRates,
  getMessageRateForCategory,
  invalidateCache,
};
