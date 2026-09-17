const db = require('../config/db');
const Project = require('../models/Project');
const { normalizeBillingCategory } = require('./wccCountryPricingService');

const WCC_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'];

const DEFAULT_SETTINGS = {
  marketing: { label: 'Marketing', original_amount: 0.95, extra_amount: 0 },
  utility: { label: 'Utility', original_amount: 0.15, extra_amount: 0 },
  authentication: { label: 'Authentication', original_amount: 0.129, extra_amount: 0 },
  service: { label: 'Service', original_amount: 0, extra_amount: 0 },
};

let schemaReady = false;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function normalizeCategory(category) {
  return normalizeBillingCategory(category);
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!Array.isArray(rows) || rows.length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureWccSettingsSchema() {
  if (schemaReady) return;
  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS wcc_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(30) NOT NULL,
        label VARCHAR(100) NOT NULL,
        original_amount DECIMAL(12,4) NOT NULL DEFAULT 0,
        extra_amount DECIMAL(12,4) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_wcc_settings_category (category)
      )
    `);

    await ensureColumn(conn, 'wcc_settings', 'label', "VARCHAR(100) NOT NULL DEFAULT ''");
    await ensureColumn(conn, 'wcc_settings', 'original_amount', 'DECIMAL(12,4) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'wcc_settings', 'extra_amount', 'DECIMAL(12,4) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'wcc_settings', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn(conn, 'wcc_settings', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn(conn, 'projects', 'wcc_extra_credits', 'DECIMAL(12,4) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'wcc_transactions', 'original_amount', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'extra_amount', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'customer_charge', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'customer_wallet_before', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'customer_wallet_after', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'business_wcc_before', 'DECIMAL(12,4) NULL');
    await ensureColumn(conn, 'wcc_transactions', 'business_wcc_after', 'DECIMAL(12,4) NULL');

    for (const category of WCC_CATEGORIES) {
      const def = DEFAULT_SETTINGS[category];
      await conn.query(
        `INSERT INTO wcc_settings (category, label, original_amount, extra_amount, is_active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [category, def.label, def.original_amount, def.extra_amount]
      );
    }

    schemaReady = true;
  } finally {
    conn.release();
  }
}

async function normalizeSettingAmounts(row, category) {
  const cat = normalizeCategory(category || row?.category);
  let original = roundMoney(row?.original_amount);
  let extra = roundMoney(row?.extra_amount);

  if (extra > 0) {
    return { original_amount: original, extra_amount: extra };
  }

  let metaOriginal = roundMoney(DEFAULT_SETTINGS[cat]?.original_amount ?? 0);
  try {
    const { getCachedMessageRates } = require('./conversationMetricsService');
    const rates = getCachedMessageRates();
    const fromMetrics = roundMoney(rates?.[cat] ?? 0);
    if (fromMetrics > 0) metaOriginal = fromMetrics;
  } catch (_) {
    /* optional metrics lookup */
  }

  if (original <= 0 && metaOriginal > 0) {
    original = metaOriginal;
  } else if (original > metaOriginal && metaOriginal > 0) {
    extra = roundMoney(original - metaOriginal);
    original = metaOriginal;
  }

  return { original_amount: original, extra_amount: extra };
}

async function getSettingRow(category) {
  await ensureWccSettingsSchema();
  const cat = normalizeCategory(category);
  const [rows] = await db.query(
    `SELECT category, label, original_amount, extra_amount, is_active
     FROM wcc_settings
     WHERE category = ? AND is_active = 1
     LIMIT 1`,
    [cat]
  );
  if (rows?.length) {
    const amounts = await normalizeSettingAmounts(rows[0], cat);
    return { ...rows[0], ...amounts };
  }
  const def = DEFAULT_SETTINGS[cat] || DEFAULT_SETTINGS.marketing;
  const amounts = await normalizeSettingAmounts(def, cat);
  return {
    category: cat,
    label: def.label,
    original_amount: amounts.original_amount,
    extra_amount: amounts.extra_amount,
    is_active: 1,
  };
}

async function resolveTransactionAmounts(row) {
  const deducted = roundMoney(row.customer_charge ?? row.amount);
  let originalAmount = roundMoney(row.original_amount ?? 0);
  let extraAmount = roundMoney(row.extra_amount ?? 0);
  const storedTotal = roundMoney(originalAmount + extraAmount);
  const hasValidSplit =
    deducted > 0 &&
    extraAmount > 0 &&
    Math.abs(storedTotal - deducted) < 0.02;

  if (hasValidSplit) {
    return { deducted, originalAmount, extraAmount, customerCharge: deducted };
  }

  if (row.category) {
    const priced = await calculateWcc(row.category);
    if (deducted <= 0) {
      return {
        deducted: priced.customerCharge,
        originalAmount: priced.originalAmount,
        extraAmount: priced.extraAmount,
        customerCharge: priced.customerCharge,
      };
    }

    if (Math.abs(priced.customerCharge - deducted) < 0.02) {
      return {
        deducted,
        originalAmount: priced.originalAmount,
        extraAmount: priced.extraAmount,
        customerCharge: deducted,
      };
    }

    if (priced.extraAmount > 0 && deducted > priced.extraAmount) {
      return {
        deducted,
        originalAmount: roundMoney(deducted - priced.extraAmount),
        extraAmount: priced.extraAmount,
        customerCharge: deducted,
      };
    }

    if (priced.originalAmount > 0 && deducted >= priced.originalAmount) {
      return {
        deducted,
        originalAmount: priced.originalAmount,
        extraAmount: roundMoney(Math.max(0, deducted - priced.originalAmount)),
        customerCharge: deducted,
      };
    }
  }

  return { deducted, originalAmount, extraAmount, customerCharge: deducted };
}

async function calculateWcc(category, opts = {}) {
  const cat = normalizeCategory(category);
  const setting = await getSettingRow(cat);
  const originalAmount = roundMoney(setting.original_amount);
  const extraAmount = roundMoney(setting.extra_amount);
  const customerCharge = roundMoney(originalAmount + extraAmount);

  return {
    category: cat,
    label: setting.label || DEFAULT_SETTINGS[cat]?.label || cat,
    originalAmount,
    extraAmount,
    customerCharge,
  };
}

async function isMessageAlreadySettled(messageId) {
  const wamid = String(messageId || '').trim();
  if (!wamid) return false;
  const [rows] = await db.query(
    `SELECT id FROM wcc_transactions
     WHERE message_id = ? AND COALESCE(status, 'charged') IN ('charged', 'completed')
     LIMIT 1`,
    [wamid]
  );
  return rows?.length > 0;
}

async function settleWccCharge({
  projectId,
  ownerUserId,
  messageId,
  category,
  recipientPhone = null,
  contact = null,
  walletCurrency = null,
}) {
  await ensureWccSettingsSchema();

  const pid = Number(projectId);
  const uid = Number(ownerUserId);
  const wamid = String(messageId || '').trim();
  const cat = normalizeCategory(category);

  if (!Number.isInteger(pid) || pid <= 0 || !wamid) {
    return { ok: false, skipped: true, reason: 'invalid_input' };
  }

  if (await isMessageAlreadySettled(wamid)) {
    return { ok: true, skipped: true, alreadyCharged: true, messageId: wamid };
  }

  const pricing = await calculateWcc(cat, {
    recipientPhone,
    contact,
    ownerUserId: uid,
    walletCurrency,
  });

  const { originalAmount, extraAmount, customerCharge } = pricing;
  if (customerCharge <= 0) {
    return { ok: true, skipped: true, amount: 0, category: cat };
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [dupRows] = await conn.query(
      `SELECT id FROM wcc_transactions
       WHERE message_id = ? AND COALESCE(status, 'charged') IN ('charged', 'completed')
       LIMIT 1 FOR UPDATE`,
      [wamid]
    );
    if (dupRows?.length) {
      await conn.commit();
      return { ok: true, skipped: true, alreadyCharged: true, messageId: wamid };
    }

    const customerWalletBefore = roundMoney(await Project.getWccCredits(pid, uid));
    if (customerWalletBefore < customerCharge) {
      throw new Error('Insufficient WCC balance');
    }

    const [projectRows] = await conn.query(
      'SELECT COALESCE(wcc_extra_credits, 0) AS wcc_extra_credits FROM projects WHERE id = ? LIMIT 1 FOR UPDATE',
      [pid]
    );
    const businessWccBefore = roundMoney(projectRows?.[0]?.wcc_extra_credits || 0);

    const [decResult] = await conn.query(
      `UPDATE projects
       SET wcc_credits = ROUND(COALESCE(wcc_credits, 0) - ?, 2)
       WHERE id = ? AND ROUND(COALESCE(wcc_credits, 0), 2) >= ?`,
      [customerCharge, pid, customerCharge]
    );
    if (!Number(decResult?.affectedRows)) {
      throw new Error('Insufficient WCC balance');
    }

    const [[walletRow]] = await conn.query(
      'SELECT COALESCE(wcc_credits, 0) AS wcc_credits FROM projects WHERE id = ? LIMIT 1',
      [pid]
    );
    const customerWalletAfter = roundMoney(walletRow?.wcc_credits || 0);
    const businessWccAfter = roundMoney(businessWccBefore + extraAmount);

    await conn.query(
      'UPDATE projects SET wcc_extra_credits = ? WHERE id = ?',
      [businessWccAfter, pid]
    );

    await conn.query(
      `INSERT INTO wcc_transactions
        (user_id, project_id, message_id, category, amount, currency, status,
         original_amount, extra_amount, customer_charge,
         customer_wallet_before, customer_wallet_after,
         business_wcc_before, business_wcc_after)
       VALUES (?, ?, ?, ?, ?, 'INR', 'completed', ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid || 0,
        pid,
        wamid,
        cat,
        customerCharge,
        originalAmount,
        extraAmount,
        customerCharge,
        customerWalletBefore,
        customerWalletAfter,
        businessWccBefore,
        businessWccAfter,
      ]
    );

    await conn.query(
      `UPDATE inboxmessages
       SET wcc_charged = 1,
           wcc_amount = ?,
           wcc_charged_at = NOW(),
           whatsapp_category = ?
       WHERE waMessageId = ?`,
      [customerCharge, cat, wamid]
    );

    await conn.commit();

    return {
      ok: true,
      charged: true,
      messageId: wamid,
      category: cat,
      originalAmount,
      extraAmount,
      customerCharge,
      deducted: customerCharge,
      extraCredited: extraAmount,
      customerWalletBefore,
      customerWalletAfter,
      businessWccBefore,
      businessWccAfter,
      remainingBalance: customerWalletAfter,
      projectId: pid,
    };
  } catch (err) {
    await conn.rollback();
    if (String(err?.code || '') === 'ER_DUP_ENTRY') {
      return { ok: true, skipped: true, alreadyCharged: true, messageId: wamid };
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function listAdminWccSettings() {
  await ensureWccSettingsSchema();
  const [rows] = await db.query(
    `SELECT category, label, original_amount, extra_amount, is_active, updated_at
     FROM wcc_settings
     ORDER BY FIELD(category, 'marketing', 'utility', 'authentication', 'service')`
  );
  const settings = await Promise.all(
    (rows || []).map(async (row) => {
      const amounts = await normalizeSettingAmounts(row, row.category);
      const originalAmount = roundMoney(amounts.original_amount);
      const extraAmount = roundMoney(amounts.extra_amount);
      return {
        category: row.category,
        label: row.label,
        originalAmount,
        extraAmount,
        customerCharge: roundMoney(originalAmount + extraAmount),
        isActive: row.is_active === 1 || row.is_active === true,
        updatedAt: row.updated_at,
      };
    })
  );
  return { settings, categories: WCC_CATEGORIES };
}

async function updateAdminWccSettings(body = {}) {
  await ensureWccSettingsSchema();
  const normalizedUpdates = Array.isArray(body.settings) ? body.settings : [];

  for (const item of normalizedUpdates) {
    const category = normalizeCategory(item.category);
    if (!WCC_CATEGORIES.includes(category)) continue;
    const originalAmount = roundMoney(
      item.originalAmount ?? item.original_amount ?? DEFAULT_SETTINGS[category].original_amount
    );
    const extraAmount = roundMoney(item.extraAmount ?? item.extra_amount ?? 0);
    const label = String(item.label || DEFAULT_SETTINGS[category].label).trim() || DEFAULT_SETTINGS[category].label;
    await db.query(
      `INSERT INTO wcc_settings (category, label, original_amount, extra_amount, is_active)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         label = VALUES(label),
         original_amount = VALUES(original_amount),
         extra_amount = VALUES(extra_amount),
         is_active = 1`,
      [category, label, originalAmount, extraAmount]
    );
  }

  return listAdminWccSettings();
}

async function listProjectWccTransactions(projectId, limit = 10, offset = 0) {
  await ensureWccSettingsSchema();
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { balance: 0, transactions: [], total: 0, limit: 10, offset: 0 };
  }

  const max = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  const [[projectRow]] = await db.query(
    'SELECT COALESCE(wcc_extra_credits, 0) AS wcc_extra_credits FROM projects WHERE id = ? LIMIT 1',
    [pid]
  );

  const [[countRow]] = await db.query(
    'SELECT COUNT(*) AS total FROM wcc_transactions WHERE project_id = ?',
    [pid]
  );

  const [rows] = await db.query(
    `SELECT id, message_id, category, amount, original_amount, extra_amount, customer_charge,
            customer_wallet_before, customer_wallet_after,
            business_wcc_before, business_wcc_after, status, created_at
     FROM wcc_transactions
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [pid, max, off]
  );

  const transactions = await Promise.all(
    (rows || []).map(async (row) => {
      const split = await resolveTransactionAmounts(row);
      return {
        id: row.id,
        messageId: row.message_id,
        category: row.category,
        deducted: split.deducted,
        originalAmount: split.originalAmount,
        extraAmount: split.extraAmount,
        customerCharge: split.customerCharge,
        customerWalletBefore: roundMoney(row.customer_wallet_before ?? 0),
        customerWalletAfter: roundMoney(row.customer_wallet_after ?? 0),
        businessWccBefore: roundMoney(row.business_wcc_before ?? 0),
        businessWccAfter: roundMoney(row.business_wcc_after ?? 0),
        status: row.status || 'completed',
        createdAt: row.created_at,
      };
    })
  );

  return {
    balance: roundMoney(projectRow?.wcc_extra_credits || 0),
    transactions,
    total: Number(countRow?.total) || 0,
    limit: max,
    offset: off,
  };
}

async function exportProjectWccTransactions(projectId) {
  await ensureWccSettingsSchema();
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      balance: 0,
      projectName: '',
      businessName: '',
      transactions: [],
    };
  }

  const [[projectRow]] = await db.query(
    `SELECT p.project_name, COALESCE(p.wcc_extra_credits, 0) AS wcc_extra_credits,
            u.name AS business_name, u.email AS business_email
     FROM projects p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = ?
     LIMIT 1`,
    [pid]
  );

  const [rows] = await db.query(
    `SELECT id, message_id, category, amount, original_amount, extra_amount, customer_charge,
            customer_wallet_before, customer_wallet_after,
            business_wcc_before, business_wcc_after, status, created_at
     FROM wcc_transactions
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC`,
    [pid]
  );

  const transactions = await Promise.all(
    (rows || []).map(async (row) => {
      const split = await resolveTransactionAmounts(row);
      return {
        id: row.id,
        messageId: row.message_id,
        category: row.category,
        deducted: split.deducted,
        originalAmount: split.originalAmount,
        extraAmount: split.extraAmount,
        customerCharge: split.customerCharge,
        status: row.status || 'completed',
        createdAt: row.created_at,
      };
    })
  );

  return {
    balance: roundMoney(projectRow?.wcc_extra_credits || 0),
    projectName: projectRow?.project_name || '',
    businessName: projectRow?.business_name || projectRow?.business_email || '',
    transactions,
  };
}

module.exports = {
  WCC_CATEGORIES,
  ensureWccSettingsSchema,
  calculateWcc,
  settleWccCharge,
  isMessageAlreadySettled,
  listAdminWccSettings,
  updateAdminWccSettings,
  listProjectWccTransactions,
  exportProjectWccTransactions,
};
