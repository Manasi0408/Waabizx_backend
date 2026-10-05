const db = require('../config/db');
const Project = require('../models/Project');
const { getCachedMessageRates } = require('./conversationMetricsService');
const { resolveTemplateBillingCategory } = require('../utils/messageCategoryPricing');
const {
  getMessageWccChargeInWalletCurrency,
  maybePersistContactCountryCode,
  ensureWccCountryPricingSchema,
  resolveRecipientCountryCode,
  getWalletCurrencyForOwner,
} = require('./wccCountryPricingService');
const { Template } = require('../models');
const socketService = require('./socketService');

let schemaReady = false;

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeCategory(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (['marketing', 'utility', 'authentication', 'service'].includes(c)) return c;
  if (c === 'promotional' || c === 'welcome') return 'marketing';
  if (c === 'transactional' || c === 'notification') return 'utility';
  if (c === 'auth') return 'authentication';
  return 'marketing';
}

function shouldChargeWcc({ category, inside24HourWindow }) {
  const cat = normalizeCategory(category);
  if (cat === 'service') return false;
  if (cat === 'utility' && inside24HourWindow) return false;
  return true;
}

function isInside24HourWindow(lastCustomerMessageAt) {
  if (!lastCustomerMessageAt) return false;
  const last = new Date(lastCustomerMessageAt);
  if (Number.isNaN(last.getTime())) return false;
  const hours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  return hours <= 24;
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!Array.isArray(rows) || rows.length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function seedDefaultRates(conn) {
  const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM wcc_rates');
  const total = Number(countRows?.[0]?.total || 0);
  if (total > 0) return;

  let rates = {};
  try {
    rates = getCachedMessageRates() || {};
  } catch (_) {
    rates = {};
  }

  const defaults = {
    marketing: rates.marketing ?? 0.95,
    utility: rates.utility ?? 0.15,
    authentication: rates.authentication ?? 0.129,
    service: rates.service ?? 0,
  };

  for (const [category, rateInr] of Object.entries(defaults)) {
    await conn.query(
      `INSERT INTO wcc_rates (category, rate_inr, active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE rate_inr = VALUES(rate_inr), active = 1`,
      [category, roundAmount(rateInr)]
    );
  }
}

async function ensureWccSchema() {
  if (schemaReady) return;
  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS wcc_rates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(30) NOT NULL,
        rate_inr DECIMAL(12,6) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        UNIQUE KEY unique_wcc_rate_category (category)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS wcc_wallets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        project_id BIGINT NULL,
        balance DECIMAL(12,6) DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'INR',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_wcc_wallet (user_id, project_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS wcc_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        project_id BIGINT NULL,
        message_id VARCHAR(255) NOT NULL,
        category VARCHAR(30) NOT NULL,
        amount DECIMAL(12,6) NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        status VARCHAR(30) DEFAULT 'charged',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_message_charge (message_id)
      )
    `);

    await ensureColumn(conn, 'inboxmessages', 'wcc_charged', 'BOOLEAN DEFAULT FALSE');
    await ensureColumn(conn, 'inboxmessages', 'wcc_amount', 'DECIMAL(12,6) DEFAULT 0');
    await ensureColumn(conn, 'inboxmessages', 'wcc_charged_at', 'DATETIME NULL');
    await ensureColumn(conn, 'inboxmessages', 'whatsapp_category', 'VARCHAR(30) NULL');

    await ensureColumn(conn, 'contacts', 'last_customer_message_at', 'DATETIME NULL');

    await seedDefaultRates(conn);
    schemaReady = true;
  } finally {
    conn.release();
  }
}

async function ensureWallet(conn, userId, projectId) {
  const uid = Number(userId);
  const pid = projectId != null ? Number(projectId) : null;
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error('Invalid WCC wallet user');
  }

  const [existing] = await conn.query(
    `SELECT id, balance FROM wcc_wallets
     WHERE user_id = ? AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
     LIMIT 1`,
    [uid, pid, pid]
  );

  if (existing.length > 0) {
    if (pid) {
      let projectBalance = 0;
      try {
        projectBalance = await Project.getWccCredits(pid, uid);
      } catch (_) {
        projectBalance = Number(existing[0].balance) || 0;
      }
      const synced = roundAmount(projectBalance);
      if (roundAmount(existing[0].balance) !== synced) {
        await conn.query('UPDATE wcc_wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [
          synced,
          existing[0].id,
        ]);
        existing[0].balance = synced;
      }
    }
    return existing[0];
  }

  let balance = 0;
  if (pid) {
    try {
      balance = await Project.getWccCredits(pid, uid);
    } catch (_) {
      balance = 0;
    }
  }

  await conn.query(
    `INSERT INTO wcc_wallets (user_id, project_id, balance, currency, updated_at)
     VALUES (?, ?, ?, 'INR', NOW())`,
    [uid, pid, roundAmount(balance)]
  );

  const [created] = await conn.query(
    `SELECT id, balance FROM wcc_wallets
     WHERE user_id = ? AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
     LIMIT 1`,
    [uid, pid, pid]
  );
  return created[0];
}

async function resolveCategoryForInboxMessage(inboxMsg) {
  const stored = inboxMsg?.whatsapp_category || inboxMsg?.get?.('whatsapp_category');
  if (stored) return normalizeCategory(stored);

  if (inboxMsg?.isTemplateSend) {
    const templateName = String(inboxMsg.templateName || '').trim();
    if (templateName) {
      try {
        const where = { name: templateName };
        if (inboxMsg.userId) where.userId = inboxMsg.userId;
        if (inboxMsg.projectId) where.projectId = inboxMsg.projectId;
        const template = await Template.findOne({ where });
        if (template) {
          return normalizeCategory(resolveTemplateBillingCategory(template));
        }
      } catch (_) {
        /* optional lookup */
      }
    }
    return 'marketing';
  }

  return 'service';
}

async function chargeWccForDeliveredMessage({
  messageId,
  userId,
  projectId,
  category,
  inside24HourWindow = false,
  recipientPhone = null,
  contact = null,
}) {
  await ensureWccSchema();
  await ensureWccCountryPricingSchema();

  const waMessageId = String(messageId || '').trim();
  let uid = Number(userId);
  const pid = projectId != null ? Number(projectId) : null;
  const normalizedCategory = normalizeCategory(category);

  if (pid) {
    try {
      const ownerId = await Project.getProjectOwnerId(pid);
      if (ownerId != null && Number(ownerId) > 0) {
        uid = Number(ownerId);
      }
    } catch (_) {
      /* use provided userId */
    }
  }

  if (!waMessageId || !pid) {
    return { charged: false, skipped: true, reason: 'invalid_input' };
  }

  if (!Number.isInteger(uid) || uid <= 0) {
    uid = Number(userId) > 0 ? Number(userId) : null;
  }

  if (!shouldChargeWcc({ category: normalizedCategory, inside24HourWindow })) {
    console.log(`[WCC] No charge for ${waMessageId} (${normalizedCategory}, 24h=${inside24HourWindow})`);
    return { charged: false, skipped: true, reason: 'policy_skip', category: normalizedCategory };
  }

  const walletCurrency = await getWalletCurrencyForOwner(uid);
  const { settleWccCharge } = require('./wccSettingsService');
  const result = await settleWccCharge({
    projectId: pid,
    ownerUserId: uid,
    messageId: waMessageId,
    category: normalizedCategory,
    recipientPhone,
    contact,
    walletCurrency,
  });

  if (result.alreadyCharged) {
    return { charged: false, alreadyCharged: true, messageId: waMessageId };
  }
  if (result.skipped && !result.charged) {
    return {
      charged: false,
      amount: 0,
      category: normalizedCategory,
      messageId: waMessageId,
      projectId: pid,
      reason: result.reason,
    };
  }

  if (uid && result.charged) {
    const conn = await db.getConnection();
    try {
      await ensureWallet(conn, uid, pid);
      await conn.query(
        `UPDATE wcc_wallets SET balance = ?, updated_at = NOW()
         WHERE user_id = ? AND project_id = ?`,
        [roundAmount(result.customerWalletAfter ?? result.remainingBalance), uid, pid]
      );
    } finally {
      conn.release();
    }
  }

  console.log(
    `[WCC] Charged ₹${result.customerCharge} (original ₹${result.originalAmount}, extra ₹${result.extraAmount}) for ${waMessageId} (${normalizedCategory}) project=${pid}`
  );

  return {
    charged: !!result.charged,
    amount: result.customerCharge || 0,
    originalAmount: result.originalAmount,
    extraAmount: result.extraAmount,
    category: normalizedCategory,
    remainingBalance: roundAmount(result.customerWalletAfter ?? result.remainingBalance),
    messageId: waMessageId,
    projectId: pid,
  };
}

async function chargeWccForDeliveredInboxMessage(inboxMsg, { Contact } = {}) {
  if (!inboxMsg || inboxMsg.direction !== 'outgoing') {
    return { charged: false, skipped: true, reason: 'not_outgoing' };
  }

  const waMessageId = inboxMsg.waMessageId || inboxMsg.get?.('waMessageId');
  if (!waMessageId) {
    return { charged: false, skipped: true, reason: 'missing_wa_message_id' };
  }

  if (inboxMsg.wcc_charged || inboxMsg.get?.('wcc_charged')) {
    return { charged: false, alreadyCharged: true, messageId: waMessageId };
  }

  const category = await resolveCategoryForInboxMessage(inboxMsg);
  let inside24HourWindow = false;
  let contact = null;

  if (inboxMsg.contactId && Contact) {
    try {
      contact = await Contact.findByPk(inboxMsg.contactId, {
        attributes: ['id', 'phone', 'country', 'country_code', 'last_customer_message_at', 'lastCustomerMessageAt'],
      });
      const lastAt =
        contact?.last_customer_message_at ||
        contact?.lastCustomerMessageAt ||
        contact?.get?.('last_customer_message_at') ||
        contact?.get?.('lastCustomerMessageAt');
      inside24HourWindow = isInside24HourWindow(lastAt);
    } catch (_) {
      inside24HourWindow = false;
    }
  }

  const recipientPhone =
    inboxMsg.phone ||
    inboxMsg.get?.('phone') ||
    contact?.phone ||
    contact?.get?.('phone') ||
    null;

  if (contact?.id) {
    await maybePersistContactCountryCode(
      contact.id,
      resolveRecipientCountryCode({ phone: recipientPhone, contact })
    );
  }

  const result = await chargeWccForDeliveredMessage({
    messageId: waMessageId,
    userId: inboxMsg.userId,
    projectId: inboxMsg.projectId,
    category,
    inside24HourWindow,
    recipientPhone,
    contact,
  });

  if (result?.remainingBalance != null && inboxMsg.userId) {
    try {
      socketService.emitToUser(inboxMsg.userId, 'wcc-quota-updated', {
        wccCredits: result.remainingBalance,
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  return result;
}

module.exports = {
  ensureWccSchema,
  shouldChargeWcc,
  isInside24HourWindow,
  normalizeCategory,
  chargeWccForDeliveredMessage,
  chargeWccForDeliveredInboxMessage,
};
