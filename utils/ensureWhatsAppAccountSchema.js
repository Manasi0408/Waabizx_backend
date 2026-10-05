const db = require('../config/db');

const SCHEMA_COLUMNS = [
  { name: 'business_id', ddl: 'VARCHAR(50) NULL' },
  { name: 'account_status', ddl: "VARCHAR(20) NULL DEFAULT 'INACTIVE'" },
  {
    name: 'aisensy_solution_id',
    ddl: 'VARCHAR(50) NULL',
    comment: 'Meta WhatsApp Business Solution ID (Embedded Signup partner billing)',
  },
];

const LEGACY_COLUMNS_TO_DROP = [
  'gupshup_credit_line_attached',
  'gupshup_app_id',
  'payment_status',
  'razorpay_order_id',
  'razorpay_payment_id',
  'paid_at',
  'aisensy_credit_line_attached',
  'aisensy_payment_method_ready',
  'aisensy_credit_line_attached_at',
];

let ensured = false;

async function columnExists(table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return Array.isArray(rows) && rows.length > 0;
}

async function dropColumnIfExists(table, column) {
  if (!(await columnExists(table, column))) return;
  try {
    await db.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    console.log(`[schema] Dropped ${table}.${column}`);
  } catch (e) {
    console.warn(`[schema] drop ${table}.${column}:`, e?.message || e);
  }
}

/** Migrate legacy Gupshup column names → AiSensy before dropping billing columns. */
async function migrateGupshupColumnsToAisensy() {
  const table = 'whatsapp_accounts';
  const hasLegacyCredit = await columnExists(table, 'gupshup_credit_line_attached');
  const hasAisensyCredit = await columnExists(table, 'aisensy_credit_line_attached');

  if (hasLegacyCredit && !hasAisensyCredit) {
    await db.query(
      `ALTER TABLE ${table} CHANGE COLUMN gupshup_credit_line_attached aisensy_credit_line_attached TINYINT(1) NULL DEFAULT 0`
    );
    console.log('[schema] Renamed whatsapp_accounts.gupshup_credit_line_attached → aisensy_credit_line_attached');
  }
}

async function dropLegacyWhatsAppPaymentColumns() {
  const table = 'whatsapp_accounts';
  for (const col of LEGACY_COLUMNS_TO_DROP) {
    await dropColumnIfExists(table, col);
  }
}

async function addColumnIfMissing(table, name, ddl) {
  if (await columnExists(table, name)) return;
  try {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (!/duplicate column|already exists/i.test(msg)) {
      console.warn(`[schema] ${table}.${name}:`, msg);
    }
  }
}

async function ensureProjectsWhatsAppNumberIdColumn() {
  if (!(await columnExists('projects', 'whatsapp_number_id'))) {
    try {
      await db.query('ALTER TABLE projects ADD COLUMN whatsapp_number_id VARCHAR(100) NULL');
      console.log('[schema] Added projects.whatsapp_number_id');
    } catch (e) {
      console.warn('[schema] projects.whatsapp_number_id:', e?.message || e);
    }
  }
}

function readAisensySolutionIdFromEnv() {
  return String(
    process.env.META_SOLUTION_ID ||
      process.env.AISENSY_SOLUTION_ID ||
      process.env.REACT_APP_META_SOLUTION_ID ||
      ''
  ).trim() || null;
}

/**
 * Backfill row data after schema cleanup — safe to run repeatedly.
 * - Mark fully linked WABA rows ACTIVE / connected
 * - Fill aisensy_solution_id from env when missing
 * - Sync projects.whatsapp_number_id from whatsapp_accounts
 */
async function backfillWhatsAppAccountData() {
  const solutionId = readAisensySolutionIdFromEnv();
  const summary = {
    activatedAccounts: 0,
    solutionIdFilled: 0,
    projectsSynced: 0,
    solutionId: solutionId || null,
  };

  const [activateResult] = await db.query(
    `UPDATE whatsapp_accounts
     SET account_status = 'ACTIVE',
         status = 'connected'
     WHERE waba_id IS NOT NULL AND TRIM(waba_id) != ''
       AND phone_number_id IS NOT NULL AND TRIM(phone_number_id) != ''
       AND access_token IS NOT NULL AND TRIM(access_token) != ''
       AND (
         account_status IS NULL OR TRIM(account_status) = '' OR account_status = 'INACTIVE'
         OR status IS NULL OR TRIM(status) = '' OR status = 'pending'
       )`
  );
  summary.activatedAccounts = Number(activateResult?.affectedRows) || 0;

  if (solutionId) {
    const [solutionResult] = await db.query(
      `UPDATE whatsapp_accounts
       SET aisensy_solution_id = ?
       WHERE (aisensy_solution_id IS NULL OR TRIM(aisensy_solution_id) = '')
         AND waba_id IS NOT NULL AND TRIM(waba_id) != ''`,
      [solutionId]
    );
    summary.solutionIdFilled = Number(solutionResult?.affectedRows) || 0;
  }

  await ensureProjectsWhatsAppNumberIdColumn();
  try {
    await addColumnIfMissing('projects', 'whatsapp_display_phone', 'VARCHAR(32) NULL');
  } catch (_) {
    /* non-fatal */
  }
  try {
    const [projectResult] = await db.query(
      `UPDATE projects p
       INNER JOIN whatsapp_accounts wa ON wa.projectId = p.id
       SET p.whatsapp_number_id = wa.phone_number_id,
           p.whatsapp_display_phone = COALESCE(
             NULLIF(TRIM(wa.display_phone), ''),
             p.whatsapp_display_phone
           )
       WHERE wa.phone_number_id IS NOT NULL AND TRIM(wa.phone_number_id) != ''
         AND (
           p.whatsapp_number_id IS NULL
           OR TRIM(p.whatsapp_number_id) = ''
           OR p.whatsapp_number_id != wa.phone_number_id
           OR p.whatsapp_display_phone IS NULL
           OR TRIM(p.whatsapp_display_phone) = ''
         )`
    );
    summary.projectsSynced = Number(projectResult?.affectedRows) || 0;
  } catch (e) {
    console.warn('[schema] projects whatsapp phone sync:', e?.message || e);
  }

  return summary;
}

async function ensureWhatsAppAccountPaymentColumns() {
  if (ensured) return;

  await migrateGupshupColumnsToAisensy();
  await dropLegacyWhatsAppPaymentColumns();

  for (const col of SCHEMA_COLUMNS) {
    await addColumnIfMissing('whatsapp_accounts', col.name, col.ddl);
  }

  const backfill = await backfillWhatsAppAccountData();
  if (
    backfill.activatedAccounts > 0 ||
    backfill.solutionIdFilled > 0 ||
    backfill.projectsSynced > 0
  ) {
    console.log('[schema] whatsapp_accounts data backfill:', backfill);
  }

  ensured = true;
  return backfill;
}

module.exports = {
  ensureWhatsAppAccountPaymentColumns,
  migrateGupshupColumnsToAisensy,
  dropLegacyWhatsAppPaymentColumns,
  backfillWhatsAppAccountData,
  ensureProjectsWhatsAppNumberIdColumn,
};
