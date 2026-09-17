const crypto = require('crypto');
const Project = require('../models/Project');
const { resolvePricingContextFromRequest } = require('../utils/geoCountry');
const {
  keyId: razorpayKeyId,
  keySecret: razorpayKeySecret,
  getRazorpayInstance,
  isRazorpayConfigured,
} = require('../config/razorpay');

const projectIdFromReq = (req) => {
  const raw =
    req.headers['x-project-id'] ??
    req.headers['x_project_id'] ??
    req.body?.projectId ??
    req.query?.projectId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const ALLOWED_PURPOSES = new Set(['wcc', 'ads_credits', 'plan_purchase']);
const MIN_AMOUNT_BY_PURPOSE = {
  wcc: 100,
  ads_credits: 1500,
  plan_purchase: 100,
};
const MIN_PLAN_AMOUNT_USD = 1;

const WCC_GST_RATE = 0.18;

const wccPayableWithGst = (baseCredits) =>
  Math.round((Number(baseCredits) + Number(baseCredits) * WCC_GST_RATE) * 100) / 100;

const normalizePaymentCurrency = (value) =>
  String(value || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';

const resolveOrderCurrency = async (req, metadata = {}, bodyCurrency = null) => {
  if (bodyCurrency) return normalizePaymentCurrency(bodyCurrency);
  if (metadata?.currency) return normalizePaymentCurrency(metadata.currency);
  try {
    const ctx = await resolvePricingContextFromRequest(req);
    return normalizePaymentCurrency(ctx.currency);
  } catch {
    return 'INR';
  }
};

exports.createWccOrder = async (req, res) => {
  try {
    const { amount, purpose = 'wcc', metadata = {}, currency: bodyCurrency = null } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (!ALLOWED_PURPOSES.has(String(purpose))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment purpose',
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount',
      });
    }

    let mergedMetadata =
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? { ...metadata } : {};

    const minAmount = MIN_AMOUNT_BY_PURPOSE[purpose] || 1;
    if (String(purpose) === 'wcc') {
      const orderCurrency = await resolveOrderCurrency(req, mergedMetadata, bodyCurrency);
      mergedMetadata.currency = orderCurrency;
      const wccCredits = Math.floor(Number(mergedMetadata.wccCredits));
      const baseForMin = Number.isFinite(wccCredits) && wccCredits > 0 ? wccCredits : numericAmount;
      if (baseForMin < minAmount) {
        return res.status(400).json({
          success: false,
          message: `Minimum amount is ${minAmount}`,
        });
      }
      if (Number.isFinite(wccCredits) && wccCredits > 0) {
        const expectedPayable =
          orderCurrency === 'USD'
            ? Math.round(wccCredits * 100) / 100
            : wccPayableWithGst(wccCredits);
        if (Math.abs(numericAmount - expectedPayable) > 0.02) {
          return res.status(400).json({
            success: false,
            message:
              orderCurrency === 'USD'
                ? 'Invalid WCC payment amount'
                : 'Invalid WCC payment amount (GST mismatch)',
          });
        }
        mergedMetadata.wccCredits = wccCredits;
      }
    } else if (String(purpose) === 'plan_purchase') {
      const orderCurrency = await resolveOrderCurrency(req, mergedMetadata, bodyCurrency);
      mergedMetadata.currency = orderCurrency;
      const planSubtotal = Number(mergedMetadata.planSubtotal);
      const baseForMin = Number.isFinite(planSubtotal) && planSubtotal > 0 ? planSubtotal : numericAmount;

      if (orderCurrency === 'USD') {
        if (baseForMin < MIN_PLAN_AMOUNT_USD) {
          return res.status(400).json({
            success: false,
            message: `Minimum amount is $${MIN_PLAN_AMOUNT_USD}`,
          });
        }
        if (Number.isFinite(planSubtotal) && planSubtotal > 0) {
          if (Math.abs(numericAmount - planSubtotal) > 0.02) {
            return res.status(400).json({
              success: false,
              message: 'Invalid plan payment amount',
            });
          }
          mergedMetadata.planSubtotal = planSubtotal;
        }
      } else {
        if (baseForMin < minAmount) {
          return res.status(400).json({
            success: false,
            message: `Minimum amount is ${minAmount}`,
          });
        }
        if (Number.isFinite(planSubtotal) && planSubtotal > 0) {
          const expectedPayable = wccPayableWithGst(planSubtotal);
          if (Math.abs(numericAmount - expectedPayable) > 0.02) {
            return res.status(400).json({
              success: false,
              message: 'Invalid plan payment amount (GST mismatch)',
            });
          }
          mergedMetadata.planSubtotal = planSubtotal;
        }
      }
    } else if (numericAmount < minAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum amount is ${minAmount}`,
      });
    }

    const razorpay = getRazorpayInstance();
    if (!isRazorpayConfigured() || !razorpay) {
      return res.status(500).json({
        success: false,
        message: 'Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env',
      });
    }

    const orderCurrency =
      String(purpose) === 'plan_purchase' || String(purpose) === 'wcc'
        ? mergedMetadata.currency || (await resolveOrderCurrency(req, mergedMetadata, bodyCurrency))
        : 'INR';
    const amountInMinorUnits = Math.round(numericAmount * 100);

    const headerProjectId = projectIdFromReq(req);
    if (headerProjectId != null && !(Number(mergedMetadata.projectId) > 0)) {
      mergedMetadata.projectId = headerProjectId;
    }
    if (
      (String(purpose) === 'wcc' || String(purpose) === 'plan_purchase') &&
      !(Number(mergedMetadata.projectId) > 0)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Select a workspace project before purchasing — plan and WCC are tied to each project.',
      });
    }

    const order = await razorpay.orders.create({
      amount: amountInMinorUnits,
      currency: orderCurrency,
      receipt: `${purpose}_${userId}_${Date.now()}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        userId: String(userId),
        purpose: String(purpose),
        projectId: String(mergedMetadata.projectId || ''),
        plan: String(mergedMetadata.plan || '').slice(0, 64),
        cycle: String(mergedMetadata.cycle || '').slice(0, 32),
        metadata: JSON.stringify(mergedMetadata).slice(0, 250),
      },
    });

    console.log(order);

    return res.json({
      success: true,
      orderId: order.id,
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpayKeyId,
      purpose,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create Razorpay order',
      error: error.message,
    });
  }
};

exports.verifyWccPayment = async (req, res) => {
  try {
    const order_id =
      req.body.order_id ||
      req.body.razorpay_order_id ||
      req.body.razorpayOrderId;
    const payment_id =
      req.body.payment_id ||
      req.body.razorpay_payment_id ||
      req.body.razorpayPaymentId;
    const razorpay_signature =
      req.body.razorpay_signature || req.body.razorpaySignature;

    if (!order_id || !payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    if (!razorpayKeySecret) {
      return res.status(500).json({
        success: false,
        message: 'Razorpay credentials not configured. Set RAZORPAY_KEY_SECRET in backend/.env',
      });
    }

    const expectedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Signature',
      });
    }

    const razorpay = getRazorpayInstance();
    if (!isRazorpayConfigured() || !razorpay) {
      return res.status(500).json({
        success: false,
        message: 'Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env',
      });
    }

    try {
      const order = await razorpay.orders.fetch(order_id);
      const notes = order?.notes || {};
      const noteUserId = Number(notes.userId);
      if (Number.isInteger(noteUserId) && noteUserId > 0 && noteUserId !== Number(req.user?.id)) {
        return res.status(403).json({
          success: false,
          message: 'Order does not belong to this user',
        });
      }
      const purpose = String(notes.purpose || 'wcc');
      if (purpose === 'wcc') {
        const amountPaise = Math.round(Number(order.amount) || 0);
        let projectId = null;
        let credits = Math.floor(amountPaise / 100);
        try {
          const meta = JSON.parse(String(notes.metadata || '{}'));
          projectId = meta?.projectId != null ? Number(meta.projectId) : null;
          const wccFromMeta = Math.floor(Number(meta?.wccCredits));
          if (Number.isFinite(wccFromMeta) && wccFromMeta > 0) {
            credits = wccFromMeta;
          }
        } catch (_) {
          projectId = null;
        }
        if (!(Number(projectId) > 0) && notes.projectId) {
          projectId = Number(notes.projectId);
        }
        if (!(Number(projectId) > 0)) {
          projectId = projectIdFromReq(req);
        }
        if (!(Number(projectId) > 0)) {
          return res.status(400).json({
            success: false,
            message: 'Project is required to credit WCC. Select a project and try again.',
          });
        }

        const ownerId = await Project.getProjectOwnerId(projectId);
        if (!ownerId) {
          return res.status(400).json({
            success: false,
            message: 'Invalid project for WCC purchase',
          });
        }
        if (Number(ownerId) !== Number(req.user.id)) {
          return res.status(403).json({
            success: false,
            message:
              'Only the project owner can purchase WhatsApp credits for this project. Log in as the owner or remove the project scope.',
          });
        }

        if (credits <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Invalid order amount',
          });
        }
        const paidAmount = Math.round((Number(order.amount) || 0) / 100 * 100) / 100;
        const creditResult = await Project.recordWccPurchase(projectId, {
          paymentId: payment_id,
          orderId: order_id,
          amount: paidAmount,
          credits,
        });
        if (!creditResult.ok) {
          return res.status(400).json({
            success: false,
            message: 'Could not credit WCC — project not found',
          });
        }
      } else if (purpose === 'plan_purchase') {
        let meta = {};
        try {
          meta = JSON.parse(String(notes.metadata || '{}'));
        } catch (_) {
          meta = {};
        }
        let projectId = meta?.projectId != null ? Number(meta.projectId) : null;
        if (!(Number(projectId) > 0) && notes.projectId) {
          projectId = Number(notes.projectId);
        }
        if (!(Number(projectId) > 0)) {
          projectId = projectIdFromReq(req);
        }
        if (!(Number(projectId) > 0)) {
          return res.status(400).json({
            success: false,
            message: 'Project is required to activate a plan. Select a project and try again.',
          });
        }

        const ownerId = await Project.getProjectOwnerId(projectId);
        if (!ownerId) {
          return res.status(400).json({
            success: false,
            message: 'Invalid project for plan purchase',
          });
        }
        if (Number(ownerId) !== Number(req.user.id)) {
          return res.status(403).json({
            success: false,
            message: 'Only the project owner can purchase a plan for this project.',
          });
        }

        const plan = String(meta.plan || notes.plan || '').trim().toLowerCase();
        const cycle = String(meta.cycle || notes.cycle || 'monthly').trim().toLowerCase();
        if (!plan) {
          return res.status(400).json({
            success: false,
            message: 'Plan slug missing from order',
          });
        }

        const purchasedAt = new Date();
        const renewsOn = new Date(purchasedAt);
        if (cycle === 'quarterly') {
          renewsOn.setMonth(renewsOn.getMonth() + 3);
        } else if (cycle === 'yearly' || cycle === 'annual') {
          renewsOn.setMonth(renewsOn.getMonth() + 12);
        } else {
          renewsOn.setMonth(renewsOn.getMonth() + 1);
        }

        const paidAmount = Math.round((Number(order.amount) || 0) / 100 * 100) / 100;
        const planResult = await Project.recordPlanPurchase(projectId, {
          paymentId: payment_id,
          orderId: order_id,
          amount: paidAmount,
          plan,
          cycle,
          purchasedAt,
          renewsOn,
        });
        if (!planResult.ok) {
          return res.status(400).json({
            success: false,
            message: 'Could not activate plan — project not found',
          });
        }
      }
    } catch (e) {
      return res.status(502).json({
        success: false,
        message: 'Could not confirm payment with Razorpay',
        error: e.message,
      });
    }

    return res.json({
      success: true,
      message: 'Payment Verified',
      paymentId: payment_id,
      orderId: order_id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to verify Razorpay payment',
      error: error.message,
    });
  }
};
