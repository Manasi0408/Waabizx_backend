const {
  getCachedMessageRates,
  getMessageRateForCategory,
  DEFAULT_METRICS,
} = require('../services/conversationMetricsService');
const { calculateCampaignWccCostEstimate } = require('../services/wccCountryPricingService');

const MESSAGE_CATEGORY_RATES = {
  marketing: DEFAULT_METRICS.marketing.rate,
  utility: DEFAULT_METRICS.utility.rate,
  authentication: DEFAULT_METRICS.authentication.rate,
  service: DEFAULT_METRICS.service.rate,
};

const BILLING_CATEGORY_LABELS = {
  marketing: 'Marketing',
  utility: 'Utility',
  authentication: 'Authentication',
  service: 'Service',
};

function normalizeTemplateBillingCategory(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (!c) return null;
  if (c === 'marketing' || c === 'promotional' || c === 'welcome') return 'marketing';
  if (c === 'utility' || c === 'transactional' || c === 'notification') return 'utility';
  if (c === 'authentication' || c === 'auth') return 'authentication';
  if (c === 'service') return 'service';
  return null;
}

function resolveTemplateBillingCategory(template) {
  if (!template) return 'marketing';

  const meta = String(template.metaCategory || '').trim().toUpperCase();
  if (meta === 'AUTHENTICATION') return 'authentication';
  if (meta === 'UTILITY') return 'utility';
  if (meta === 'MARKETING') return 'marketing';
  if (meta === 'SERVICE') return 'service';

  const candidates = [
    template.category,
    template.variables?.metaCategory,
    template.variables?.category,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTemplateBillingCategory(candidate);
    if (normalized) return normalized;
  }
  return 'marketing';
}

function getMessageRateForBillingCategory(category) {
  const key = normalizeTemplateBillingCategory(category) || String(category || 'marketing').toLowerCase();
  const rates = getCachedMessageRates();
  return rates[key] ?? rates.marketing ?? getMessageRateForCategory(key);
}

function getBillingCategoryLabel(category) {
  const key = normalizeTemplateBillingCategory(category) || String(category || 'marketing').toLowerCase();
  return BILLING_CATEGORY_LABELS[key] || 'Marketing';
}

function calculateCampaignTotalCreditUsageRupees(sentCount, billingCategory = 'marketing') {
  const sent = Math.max(0, parseInt(sentCount, 10) || 0);
  const rate = getMessageRateForBillingCategory(billingCategory);
  return Math.round(sent * rate * 100) / 100;
}

async function calculateCampaignTotalCreditUsageForPhones(phones, billingCategory = 'marketing', ownerUserId = null) {
  const estimate = await calculateCampaignWccCostEstimate({
    phones,
    billingCategory,
    ownerUserId,
  });
  return estimate.totalCost;
}

module.exports = {
  MESSAGE_CATEGORY_RATES,
  normalizeTemplateBillingCategory,
  resolveTemplateBillingCategory,
  getMessageRateForBillingCategory,
  getBillingCategoryLabel,
  calculateCampaignTotalCreditUsageRupees,
  calculateCampaignTotalCreditUsageForPhones,
};
