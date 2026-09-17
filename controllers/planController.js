const { Op } = require('sequelize');
const Plan = require('../models/Plan');
const { resolvePricingContextFromRequest } = require('../utils/geoCountry');
const {
  getPlanBillingDiscounts,
  setPlanBillingDiscounts,
} = require('../services/planDiscountService');
const DEFAULT_PLANS = [
  {
    slug: 'standard',
    name: 'Standard Project Plan',
    price_monthly: 750,
    price_quarterly: 2025,
    price_yearly: 7650,
    price_monthly_usd: 10,
    price_quarterly_usd: 27,
    price_yearly_usd: 102,
    users_limit: 0,
    messages_limit: 0,
    features: [
      'Unlimited Agents',
      'Unlimited Campaigns',
      'Unlimited Templates',
      'Unlimited Flows',
      'Unlimited Contacts',
      'Multi Agent Live Chat',
      'FREE WhatsApp Business Platform Onboarding',
      'Pay-as-you-go conversation delivery',
      'Full Developer API access & dashboard management',
    ],
    trial_days: 0,
    sort_order: 1,
    is_active: true,
  },
];

const parseJsonField = (raw, fallback = null) => {
  if (raw == null || raw === '') return fallback;
  if (Array.isArray(raw) || typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
};

const normalizeFeatures = (features) => {
  if (Array.isArray(features)) {
    return features.map((f) => String(f || '').trim()).filter(Boolean);
  }
  if (typeof features === 'string') {
    return features
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return [];
};

const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

const formatPlan = (row, options = {}) => {
  const { forCurrency = null, includeAllCurrencies = false } = options;
  const plain = row?.toJSON ? row.toJSON() : row;
  const inr = {
    price_monthly: Number(plain.price_monthly) || 0,
    price_quarterly: Number(plain.price_quarterly) || 0,
    price_yearly: Number(plain.price_yearly) || 0,
  };
  const usd = {
    price_monthly_usd: Number(plain.price_monthly_usd) || 0,
    price_quarterly_usd: Number(plain.price_quarterly_usd) || 0,
    price_yearly_usd: Number(plain.price_yearly_usd) || 0,
  };

  const base = {
    id: plain.id,
    slug: plain.slug,
    name: plain.name,
    ...inr,
    ...usd,
    users_limit: Number(plain.users_limit) || 0,
    messages_limit: Number(plain.messages_limit) || 0,
    features: parseJsonField(plain.features, []),
    trial_days: Number(plain.trial_days) || 0,
    razorpay_price_ids: parseJsonField(plain.razorpay_price_ids, {}),
    is_active: Boolean(plain.is_active),
    sort_order: Number(plain.sort_order) || 0,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };

  if (includeAllCurrencies) {
    return base;
  }

  // Always keep INR originals so clients can show local prices even if geo returns USD
  const withBoth = {
    ...base,
    price_monthly_inr: inr.price_monthly,
    price_quarterly_inr: inr.price_quarterly,
    price_yearly_inr: inr.price_yearly,
  };

  if (forCurrency === 'USD') {
    const monthlyUsd = usd.price_monthly_usd || DEFAULT_PLANS[0].price_monthly_usd;
    const quarterlyUsd = usd.price_quarterly_usd || DEFAULT_PLANS[0].price_quarterly_usd;
    const yearlyUsd = usd.price_yearly_usd || DEFAULT_PLANS[0].price_yearly_usd;
    return {
      ...withBoth,
      currency: 'USD',
      price_monthly: monthlyUsd,
      price_quarterly: quarterlyUsd,
      price_yearly: yearlyUsd,
      price_monthly_usd: monthlyUsd,
      price_quarterly_usd: quarterlyUsd,
      price_yearly_usd: yearlyUsd,
    };
  }

  return {
    ...withBoth,
    currency: 'INR',
    price_monthly: inr.price_monthly,
    price_quarterly: inr.price_quarterly,
    price_yearly: inr.price_yearly,
  };
};

/** Hide outdated Basic/Pro/Enterprise-style tiers — keep cycle-based standard plans only */
const isLegacyNamedTier = (plan) => {
  const slug = String(plan?.slug || '').toLowerCase().trim();
  const name = String(plan?.name || '').toLowerCase().trim();
  if (slug === 'pro' || slug === 'basic' || slug === 'enterprise') return true;
  if (name === 'pro' || name === 'basic' || name === 'enterprise') return true;
  if (/\benterprise\b/.test(name) || /\benterprise\b/.test(slug)) return true;
  if ((/\bpro\b/.test(name) || /\bpro\b/.test(slug)) && !/project|standard/.test(name + ' ' + slug)) {
    return true;
  }
  if ((/\bbasic\b/.test(name) || /\bbasic\b/.test(slug)) && !/project|standard/.test(name + ' ' + slug)) {
    return true;
  }
  return false;
};

exports.ensureDefaultPlans = async () => {
  const count = await Plan.count();
  if (count > 0) return;
  await Plan.bulkCreate(
    DEFAULT_PLANS.map((p) => ({
      ...p,
      features: JSON.stringify(p.features),
      razorpay_price_ids: JSON.stringify({}),
    }))
  );
};

exports.getActivePlans = async (req, res) => {
  try {
    await exports.ensureDefaultPlans();
    const { country, currency } = await resolvePricingContextFromRequest(req, {
      country:
        req.query?.country ||
        req.query?.countryCode ||
        req.headers?.['x-country-code'] ||
        req.headers?.['cf-ipcountry'],
    });
    const rows = await Plan.findAll({
      where: { is_active: true },
      order: [
        ['sort_order', 'ASC'],
        ['price_monthly', 'ASC'],
      ],
    });
    const discounts = await getPlanBillingDiscounts();
    // Public website needs both INR + USD amounts; client picks by visitor country.
    // (Geo IP is unreliable and previously overwrote INR with USD in price_monthly.)
    return res.json({
      success: true,
      country,
      currency,
      discounts,
      plans: rows
        .map((row) => {
          const full = formatPlan(row, { includeAllCurrencies: true });
          const display =
            currency === 'USD'
              ? {
                  ...full,
                  currency: 'USD',
                  price_monthly: full.price_monthly_usd,
                  price_quarterly: full.price_quarterly_usd,
                  price_yearly: full.price_yearly_usd,
                }
              : {
                  ...full,
                  currency: 'INR',
                  price_monthly: full.price_monthly,
                  price_quarterly: full.price_quarterly,
                  price_yearly: full.price_yearly,
                };
          return {
            ...display,
            price_monthly_inr: full.price_monthly,
            price_quarterly_inr: full.price_quarterly,
            price_yearly_inr: full.price_yearly,
          };
        })
        .filter((p) => !isLegacyNamedTier(p)),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load plans',
      error: error.message,
    });
  }
};

exports.getAllPlansAdmin = async (req, res) => {
  try {
    await exports.ensureDefaultPlans();
    const rows = await Plan.findAll({
      order: [
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const discounts = await getPlanBillingDiscounts();
    return res.json({
      success: true,
      discounts,
      plans: rows.map((row) => formatPlan(row, { includeAllCurrencies: true })).filter((p) => !isLegacyNamedTier(p)),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load plans',
      error: error.message,
    });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Plan name is required' });
    }

    const slug = slugify(body.slug || name);
    if (!slug) {
      return res.status(400).json({ success: false, message: 'Invalid plan slug' });
    }

    const exists = await Plan.findOne({ where: { slug } });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Plan slug already exists' });
    }

    const features = normalizeFeatures(body.features);
    const razorpayIds = parseJsonField(body.razorpay_price_ids, {});

    const created = await Plan.create({
      slug,
      name,
      price_monthly: Number(body.price_monthly) || 0,
      price_quarterly: Number(body.price_quarterly) || 0,
      price_yearly: Number(body.price_yearly) || 0,
      price_monthly_usd: Number(body.price_monthly_usd) || 0,
      price_quarterly_usd: Number(body.price_quarterly_usd) || 0,
      price_yearly_usd: Number(body.price_yearly_usd) || 0,
      users_limit: Math.max(0, Math.floor(Number(body.users_limit) || 0)),
      messages_limit: Math.max(0, Math.floor(Number(body.messages_limit) || 0)),
      features: JSON.stringify(features),
      trial_days: Math.max(0, Math.floor(Number(body.trial_days) || 0)),
      razorpay_price_ids: JSON.stringify(razorpayIds && typeof razorpayIds === 'object' ? razorpayIds : {}),
      is_active: body.is_active !== false && body.is_active !== 0,
      sort_order: Math.floor(Number(body.sort_order) || 0),
    });

    return res.status(201).json({
      success: true,
      plan: formatPlan(created, { includeAllCurrencies: true }),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create plan',
      error: error.message,
    });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await Plan.findByPk(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name != null) updates.name = String(body.name).trim();
    if (body.slug != null) {
      const nextSlug = slugify(body.slug);
      if (!nextSlug) {
        return res.status(400).json({ success: false, message: 'Invalid plan slug' });
      }
      const clash = await Plan.findOne({
        where: { slug: nextSlug, id: { [Op.ne]: id } },
      });
      if (clash) {
        return res.status(409).json({ success: false, message: 'Plan slug already exists' });
      }
      updates.slug = nextSlug;
    }
    if (body.price_monthly != null) updates.price_monthly = Number(body.price_monthly) || 0;
    if (body.price_quarterly != null) updates.price_quarterly = Number(body.price_quarterly) || 0;
    if (body.price_yearly != null) updates.price_yearly = Number(body.price_yearly) || 0;
    if (body.price_monthly_usd != null) updates.price_monthly_usd = Number(body.price_monthly_usd) || 0;
    if (body.price_quarterly_usd != null) updates.price_quarterly_usd = Number(body.price_quarterly_usd) || 0;
    if (body.price_yearly_usd != null) updates.price_yearly_usd = Number(body.price_yearly_usd) || 0;
    if (body.users_limit != null) updates.users_limit = Math.max(0, Math.floor(Number(body.users_limit) || 0));
    if (body.messages_limit != null) {
      updates.messages_limit = Math.max(0, Math.floor(Number(body.messages_limit) || 0));
    }
    if (body.features != null) updates.features = JSON.stringify(normalizeFeatures(body.features));
    if (body.trial_days != null) updates.trial_days = Math.max(0, Math.floor(Number(body.trial_days) || 0));
    if (body.razorpay_price_ids != null) {
      const razorpayIds = parseJsonField(body.razorpay_price_ids, {});
      updates.razorpay_price_ids = JSON.stringify(
        razorpayIds && typeof razorpayIds === 'object' ? razorpayIds : {}
      );
    }
    if (body.is_active != null) updates.is_active = Boolean(body.is_active);
    if (body.sort_order != null) updates.sort_order = Math.floor(Number(body.sort_order) || 0);

    await plan.update(updates);

    return res.json({
      success: true,
      plan: formatPlan(plan, { includeAllCurrencies: true }),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update plan',
      error: error.message,
    });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid plan id' });
    }

    const plan = await Plan.findByPk(id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    await plan.destroy();

    return res.json({
      success: true,
      message: 'Plan deleted',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete plan',
      error: error.message,
    });
  }
};

exports.getAdminPlanDiscounts = async (_req, res) => {
  try {
    const discounts = await getPlanBillingDiscounts();
    return res.json({ success: true, discounts });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load plan discounts',
      error: error.message,
    });
  }
};

exports.updateAdminPlanDiscounts = async (req, res) => {
  try {
    const discounts = await setPlanBillingDiscounts(req.body || {});
    return res.json({ success: true, discounts });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update plan discounts',
      error: error.message,
    });
  }
};
