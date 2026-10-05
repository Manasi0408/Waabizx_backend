const db = require('../config/db');
const InboxMessage = require('../models/InboxMessage');
const Project = require('../models/Project');
const {
  needsNewConversationBilling,
  startConversationIfNeeded,
  normalizePhone: normalizeCustomerPhone,
} = require('./wccConversationsService');
const { getMessageRateForBillingCategory } = require('../utils/messageCategoryPricing');
const { getWalletCurrencyForOwner } = require('./wccCountryPricingService');
const { calculateWcc, settleWccCharge, isMessageAlreadySettled } = require('./wccSettingsService');

function roundWccAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function templateCreditsForCategory(billingCategory, opts = {}) {
  try {
    const priced = await calculateWcc(billingCategory || 'marketing', {
      recipientPhone: opts.customerPhone || opts.recipientPhone || null,
      ownerUserId: opts.ownerUserId,
      walletCurrency: opts.walletCurrency,
    });
    return priced.customerCharge > 0 ? priced.customerCharge : 0;
  } catch (err) {
    console.warn('[WCC] calculateWcc fallback for template:', err?.message || err);
    const rate = getMessageRateForBillingCategory(billingCategory || 'marketing');
    const charge = roundWccAmount(rate);
    return charge > 0 ? charge : 0;
  }
}

async function resolveTemplateWaMessageId(pid, opts = {}) {
  if (opts.waMessageId) return String(opts.waMessageId);
  if (opts.inboxMessageId) {
    try {
      const row = await InboxMessage.findByPk(opts.inboxMessageId, { attributes: ['waMessageId'] });
      if (row?.waMessageId) return String(row.waMessageId);
    } catch (_) {
      /* optional */
    }
  }
  if (!pid) return null;
  try {
    const [rows] = await db.query(
      `SELECT waMessageId FROM inboxmessages
       WHERE projectId = ? AND direction = 'outgoing' AND isTemplateSend = 1
         AND waMessageId IS NOT NULL AND timestamp >= NOW() - INTERVAL 3 MINUTE
       ORDER BY id DESC LIMIT 1`,
      [pid]
    );
    if (rows?.[0]?.waMessageId) return String(rows[0].waMessageId);
  } catch (_) {
    /* optional */
  }
  return null;
}

async function isWaMessageAlreadyCharged(waMessageId) {
  const id = String(waMessageId || '').trim();
  if (!id) return false;
  try {
    if (await isMessageAlreadySettled(id)) return true;
    const [inboxRows] = await db.query(
      'SELECT wcc_charged FROM inboxmessages WHERE waMessageId = ? LIMIT 1',
      [id]
    );
    return inboxRows?.length > 0 && Boolean(inboxRows[0].wcc_charged);
  } catch (_) {
    return false;
  }
}

async function syncProjectWalletRow(projectId, ownerUserId, balance) {
  const pid = Number(projectId);
  const uid = Number(ownerUserId);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(uid) || uid <= 0) return;
  try {
    const bal = roundWccAmount(balance);
    const [existing] = await db.query(
      `SELECT id FROM wcc_wallets
       WHERE user_id = ? AND project_id = ?
       LIMIT 1`,
      [uid, pid]
    );
    if (existing?.length) {
      await db.query(
        'UPDATE wcc_wallets SET balance = ?, updated_at = NOW() WHERE id = ?',
        [bal, existing[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO wcc_wallets (user_id, project_id, balance, currency, updated_at)
         VALUES (?, ?, ?, 'INR', NOW())`,
        [uid, pid, bal]
      );
    }
  } catch (err) {
    console.warn('[WCC] syncProjectWalletRow:', err?.message || err);
  }
}

async function recordTemplateWccCharge({
  projectId,
  ownerUserId,
  amount,
  waMessageId,
  billingCategory,
}) {
  const pid = Number(projectId);
  const uid = Number(ownerUserId);
  const charge = roundWccAmount(amount);
  const wamid = String(waMessageId || '').trim();
  const category = String(billingCategory || 'marketing').trim().toLowerCase() || 'marketing';
  if (!Number.isInteger(pid) || pid <= 0 || charge <= 0 || !wamid) return;

  try {
    await db.query(
      `INSERT INTO wcc_transactions
        (user_id, project_id, message_id, category, amount, currency, status)
       VALUES (?, ?, ?, ?, ?, 'INR', 'charged')
       ON DUPLICATE KEY UPDATE id = id`,
      [Number.isInteger(uid) && uid > 0 ? uid : 0, pid, wamid, category, charge]
    );
    await db.query(
      `UPDATE inboxmessages
       SET wcc_charged = 1, wcc_amount = ?, wcc_charged_at = NOW(), whatsapp_category = ?
       WHERE waMessageId = ?`,
      [charge, category, wamid]
    );
  } catch (err) {
    console.warn('[WCC] recordTemplateWccCharge:', err?.message || err);
  }
}

function normalizeProjectId(projectId, opts = {}) {
  const raw = projectId ?? opts.projectId;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function resolveOwnerUserId(projectId, fallbackUserId = null) {
  const pid = normalizeProjectId(projectId);
  if (!pid) return null;
  let ownerUserId = await Project.getProjectOwnerId(pid);
  if (!ownerUserId && fallbackUserId != null && Number(fallbackUserId) > 0) {
    ownerUserId = Number(fallbackUserId);
  }
  return ownerUserId;
}

async function resolveBillingUserId(projectId, opts = {}) {
  return resolveOwnerUserId(projectId, opts.userId);
}

async function resolveDebitProjectId(projectId, opts = {}) {
  let pid = normalizeProjectId(projectId, opts);
  if (!pid) return null;

  if (opts.inboxMessageId || opts.waMessageId) {
    try {
      let row = null;
      if (opts.inboxMessageId) {
        row = await InboxMessage.findByPk(opts.inboxMessageId, { attributes: ['projectId'] });
      }
      if (!row && opts.waMessageId) {
        row = await InboxMessage.findOne({
          where: { waMessageId: String(opts.waMessageId) },
          attributes: ['projectId'],
        });
      }
      const rowPid = Number(row?.projectId);
      if (Number.isInteger(rowPid) && rowPid > 0) {
        pid = rowPid;
      }
    } catch (_) {
      /* use request project id */
    }
  }

  return pid;
}

function n(envKey, def) {
  const v = parseInt(process.env[envKey], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/**
 * When true, skip balance checks and do not debit WCC (templates, chat, inbox, campaigns).
 * Use only for development or deployments that bill outside this ledger.
 */
function isWccEnforcementDisabled() {
  const raw = String(
    process.env.DISABLE_WCC_ENFORCEMENT ||
      process.env.WCC_DISABLE_ENFORCEMENT ||
      process.env.WCC_ENFORCEMENT_DISABLED ||
      ''
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function parseInboxPayload(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * WCC — backend-only balance (Meta never sends credits).
 *
 * When `opts.customerPhone` is set, the 24h “new conversation” rule uses table
 * `wcc_conversations` (project_id + user_phone). Session debits run only after a
 * successful delivery via `debitWccOnMessageDelivered`.
 *
 * Without `customerPhone`, falls back to `billing.wasNew` from realconversation.
 */
function computeMetaWccCharge(billing = {}, opts = {}) {
  const customerPhone =
    opts.customerPhone != null ? normalizeCustomerPhone(opts.customerPhone) : '';
  const wasNew = !!billing.wasNew;
  const isTemplate = !!opts.isTemplate;
  const conversationRupees = n('WCC_META_CONVERSATION_CREDITS', 1);
  const perMsg = n('WCC_META_PER_MESSAGE_CREDITS', 0);
  const tmpl = isTemplate ? n('WCC_META_TEMPLATE_SURCHARGE_CREDITS', 0) : 0;

  let sessionCharge = 0;
  if (customerPhone) {
    sessionCharge = 0;
  } else {
    sessionCharge = wasNew ? conversationRupees : 0;
  }
  return sessionCharge + perMsg + tmpl;
}

async function requireWccForOutgoing(projectId, billing, opts = {}) {
  const pid = normalizeProjectId(projectId, opts);
  const billingUserId = await resolveBillingUserId(pid, opts);

  if (isWccEnforcementDisabled()) {
    const balance = pid ? await Project.getWccCredits(pid, billingUserId) : 0;
    return {
      ok: true,
      ownerUserId: billingUserId,
      projectId: pid,
      charge: 0,
      balance,
      skipped: true,
      enforcementDisabled: true,
    };
  }

  if (!pid) {
    return { ok: true, ownerUserId: billingUserId, projectId: null, charge: 0, balance: 0, skipped: true };
  }

  if (opts.isTemplate) {
    const walletCurrency = billingUserId
      ? await getWalletCurrencyForOwner(billingUserId)
      : null;
    const charge = await templateCreditsForCategory(opts.billingCategory, {
      customerPhone: opts.customerPhone,
      ownerUserId: billingUserId,
      walletCurrency,
    });
    if (charge <= 0) {
      return {
        ok: true,
        ownerUserId: billingUserId,
        projectId: pid,
        charge: 0,
        balance: await Project.getWccCredits(pid, billingUserId),
        billingCategory: opts.billingCategory || 'service',
      };
    }
    const balance = await Project.getWccCredits(pid, billingUserId);
    if (balance < charge) {
      return {
        ok: false,
        ownerUserId: billingUserId,
        projectId: pid,
        charge,
        balance,
        billingCategory: opts.billingCategory || 'marketing',
      };
    }
    return {
      ok: true,
      ownerUserId: billingUserId,
      projectId: pid,
      charge,
      balance,
      billingCategory: opts.billingCategory || 'marketing',
    };
  }

  const customerPhone =
    opts.customerPhone != null ? normalizeCustomerPhone(opts.customerPhone) : '';
  const conversationRupees = n('WCC_META_CONVERSATION_CREDITS', 1);
  const perMsg = n('WCC_META_PER_MESSAGE_CREDITS', 0);
  const tmpl = opts.isTemplate ? n('WCC_META_TEMPLATE_SURCHARGE_CREDITS', 0) : 0;

  let sessionCharge = 0;
  if (customerPhone) {
    const need = await needsNewConversationBilling(pid, customerPhone);
    sessionCharge = need ? conversationRupees : 0;
  } else {
    sessionCharge = billing.wasNew ? conversationRupees : 0;
  }

  const charge = sessionCharge + perMsg + tmpl;
  if (charge <= 0) {
    return {
      ok: true,
      ownerUserId: billingUserId,
      projectId: pid,
      charge: 0,
      balance: await Project.getWccCredits(pid, billingUserId),
    };
  }
  const balance = await Project.getWccCredits(pid, billingUserId);
  if (balance < charge) {
    return { ok: false, ownerUserId: billingUserId, projectId: pid, charge, balance };
  }
  return { ok: true, ownerUserId: billingUserId, projectId: pid, charge, balance };
}

async function applyWccDebitNow(projectId, ownerUserId, billing, opts = {}) {
  if (isWccEnforcementDisabled()) {
    return { ok: true, deducted: 0, enforcementDisabled: true };
  }

  const pid = await resolveDebitProjectId(projectId, opts);
  const billingUserId =
    ownerUserId || (await resolveBillingUserId(pid, opts));

  if (!pid) {
    return { ok: true, deducted: 0 };
  }

  if (opts.isTemplate) {
    const waMessageId = await resolveTemplateWaMessageId(pid, opts);
    if (waMessageId && (await isWaMessageAlreadyCharged(waMessageId))) {
      const balanceAfter = await Project.getWccCredits(pid, billingUserId);
      return {
        ok: true,
        deducted: 0,
        balanceAfter,
        projectId: pid,
        alreadyDebited: true,
        billingCategory: opts.billingCategory || 'marketing',
      };
    }

    const walletCurrency = billingUserId
      ? await getWalletCurrencyForOwner(billingUserId)
      : null;
    if (!waMessageId) {
      const charge = await templateCreditsForCategory(opts.billingCategory, {
        customerPhone: opts.customerPhone,
        ownerUserId: billingUserId,
        walletCurrency,
      });
      if (charge <= 0) {
        const balanceAfter = await Project.getWccCredits(pid, billingUserId);
        return {
          ok: true,
          deducted: 0,
          balanceAfter,
          projectId: pid,
          billingCategory: opts.billingCategory || 'service',
        };
      }
      const { ok } = await Project.tryDecrementWccCredits(pid, billingUserId, charge);
      const balanceAfter = await Project.getWccCredits(pid, billingUserId);
      if (ok && billingUserId) {
        await syncProjectWalletRow(pid, billingUserId, balanceAfter);
      }
      return {
        ok,
        deducted: ok ? charge : 0,
        balanceAfter,
        projectId: pid,
        billingCategory: opts.billingCategory || 'marketing',
      };
    }

    const result = await settleWccCharge({
      projectId: pid,
      ownerUserId: billingUserId,
      messageId: waMessageId,
      category: opts.billingCategory || 'marketing',
      recipientPhone: opts.customerPhone,
      walletCurrency,
    });

    if (result.charged && billingUserId) {
      await syncProjectWalletRow(pid, billingUserId, result.customerWalletAfter);
    }

    return {
      ok: result.ok !== false,
      deducted: result.deducted || 0,
      balanceAfter: result.customerWalletAfter ?? result.remainingBalance,
      projectId: pid,
      billingCategory: opts.billingCategory || 'marketing',
      originalAmount: result.originalAmount,
      extraAmount: result.extraAmount,
      customerCharge: result.customerCharge,
      extraCredited: result.extraCredited,
      alreadyDebited: result.alreadyCharged,
    };
  }

  const customerPhone =
    opts.customerPhone != null ? normalizeCustomerPhone(opts.customerPhone) : '';

  if (customerPhone) {
    const session = await startConversationIfNeeded(pid, customerPhone);
    const perMsg = n('WCC_META_PER_MESSAGE_CREDITS', 0);
    const tmpl = opts.isTemplate ? n('WCC_META_TEMPLATE_SURCHARGE_CREDITS', 0) : 0;
    const extra = perMsg + tmpl;
    let extraOk = true;
    if (extra > 0) {
      const r = await Project.tryDecrementWccCredits(pid, billingUserId, extra);
      extraOk = r.ok;
      if (!extraOk) {
        console.error('WCC extra debit failed', { projectId: pid, ownerUserId: billingUserId, extra });
      }
    }
    const sessionCredits = session.billed ? n('WCC_META_CONVERSATION_CREDITS', 1) : 0;
    const total = sessionCredits + (extraOk ? extra : 0);
    if (session.billed || extra > 0) {
      console.log('[WCC] Ledger update (wcc_conversations + projects.wcc_credits)', {
        projectId: pid,
        ownerUserId: billingUserId,
        customerPhone,
        sessionBilled: session.billed,
        sessionCredits,
        extraDebited: extraOk ? extra : 0,
      });
    }
    const balanceAfter = await Project.getWccCredits(pid, billingUserId);
    return { ok: true, deducted: total, balanceAfter, projectId: pid };
  }

  const charge = computeMetaWccCharge(billing, opts);
  if (charge <= 0) {
    return { ok: true, deducted: 0, projectId: pid };
  }
  const { ok } = await Project.tryDecrementWccCredits(pid, billingUserId, charge);
  if (!ok) {
    console.error('WCC debit failed after successful Meta send', {
      projectId: pid,
      ownerUserId: billingUserId,
      charge,
    });
  } else {
    console.log('[WCC] Debited projects.wcc_credits (legacy billing.wasNew path)', {
      projectId: pid,
      ownerUserId: billingUserId,
      new24hConversation: !!billing.wasNew,
      totalDebited: charge,
      isTemplate: !!opts.isTemplate,
    });
  }
  const balanceAfter = ok ? await Project.getWccCredits(pid, billingUserId) : null;
  return { ok, deducted: charge, balanceAfter, projectId: pid };
}

async function savePendingWccDebit({ inboxMessageId, waMessageId, pending }) {
  let row = null;
  if (inboxMessageId) {
    row = await InboxMessage.findByPk(inboxMessageId);
  }
  if (!row && waMessageId) {
    row = await InboxMessage.findOne({ where: { waMessageId: String(waMessageId) } });
  }
  if (!row) return false;

  const payload = parseInboxPayload(row.payload);
  if (payload.wccDebited) return true;
  payload.wccPending = pending;
  await row.update({ payload: JSON.stringify(payload) });
  return true;
}

/**
 * Schedule WCC debit until WhatsApp reports the message as delivered.
 * Falls back to immediate debit when no inbox row is available.
 */
async function debitWccAfterSuccessfulMetaSend(projectId, ownerUserId, billing, opts = {}) {
  if (isWccEnforcementDisabled()) {
    return { ok: true, deducted: 0, enforcementDisabled: true };
  }

  const pid = await resolveDebitProjectId(projectId, opts);
  const resolvedOwnerId =
    ownerUserId || (await resolveBillingUserId(pid, opts));

  if (!pid) {
    return { ok: true, deducted: 0 };
  }

  // Template message cost is debited immediately after Meta accepts the send.
  if (opts.isTemplate) {
    return applyWccDebitNow(pid, resolvedOwnerId, billing, { ...opts, projectId: pid });
  }

  const pending = {
    projectId: pid,
    ownerUserId: resolvedOwnerId != null ? Number(resolvedOwnerId) : null,
    billing: { wasNew: !!billing?.wasNew },
     customerPhone:
      opts.customerPhone != null ? normalizeCustomerPhone(opts.customerPhone) : '',
    isTemplate: !!opts.isTemplate,
    billingCategory: opts.billingCategory || null,
  };

  const scheduled = await savePendingWccDebit({
    inboxMessageId: opts.inboxMessageId,
    waMessageId: opts.waMessageId,
    pending,
  });

  if (scheduled) {
    const balanceAfter = await Project.getWccCredits(pid, resolvedOwnerId);
    return { ok: true, deducted: 0, pending: true, balanceAfter, projectId: pid };
  }

  return applyWccDebitNow(pid, resolvedOwnerId, billing, { ...opts, projectId: pid });
}

/** Apply pending WCC charge when Meta delivery webhook arrives. */
async function debitWccOnMessageDelivered(inboxMessage) {
  if (!inboxMessage || inboxMessage.direction !== 'outgoing') {
    return { ok: true, deducted: 0, skipped: true };
  }

  const payload = parseInboxPayload(inboxMessage.payload);
  if (payload.wccDebited) {
    return { ok: true, deducted: 0, alreadyDebited: true };
  }

  const pending = payload.wccPending;
  if (!pending?.projectId) {
    return { ok: true, deducted: 0, skipped: true };
  }

  const result = await applyWccDebitNow(
    pending.projectId,
    pending.ownerUserId,
    pending.billing || {},
    {
      customerPhone: pending.customerPhone,
      isTemplate: pending.isTemplate,
      billingCategory: pending.billingCategory,
      projectId: pending.projectId,
    }
  );

  payload.wccDebited = true;
  payload.wccPending = null;
  payload.wccDeductedAt = new Date().toISOString();
  payload.wccDeductedAmount = Number(result.deducted) || 0;
  await inboxMessage.update({ payload: JSON.stringify(payload) });

  return result;
}

module.exports = {
  computeMetaWccCharge,
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
  debitWccOnMessageDelivered,
};
