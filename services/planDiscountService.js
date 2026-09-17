const PlatformSetting = require('../models/PlatformSetting');

const SETTING_KEY = 'plan_billing_discounts';

const DEFAULT_PLAN_BILLING_DISCOUNTS = {
  quarterlyPercent: 10,
  yearlyPercent: 15,
};

function normalizeDiscounts(raw) {
  const q = Number(raw?.quarterlyPercent);
  const y = Number(raw?.yearlyPercent);
  return {
    quarterlyPercent: Number.isFinite(q)
      ? Math.min(100, Math.max(0, q))
      : DEFAULT_PLAN_BILLING_DISCOUNTS.quarterlyPercent,
    yearlyPercent: Number.isFinite(y)
      ? Math.min(100, Math.max(0, y))
      : DEFAULT_PLAN_BILLING_DISCOUNTS.yearlyPercent,
  };
}

async function getPlanBillingDiscounts() {
  try {
    const row = await PlatformSetting.findOne({ where: { key: SETTING_KEY } });
    if (!row?.value) return { ...DEFAULT_PLAN_BILLING_DISCOUNTS };
    const parsed = JSON.parse(String(row.value));
    return normalizeDiscounts(parsed);
  } catch {
    return { ...DEFAULT_PLAN_BILLING_DISCOUNTS };
  }
}

async function setPlanBillingDiscounts(payload = {}) {
  const normalized = normalizeDiscounts(payload);
  await PlatformSetting.upsert({
    key: SETTING_KEY,
    value: JSON.stringify(normalized),
  });
  return normalized;
}

module.exports = {
  SETTING_KEY,
  DEFAULT_PLAN_BILLING_DISCOUNTS,
  normalizeDiscounts,
  getPlanBillingDiscounts,
  setPlanBillingDiscounts,
};
