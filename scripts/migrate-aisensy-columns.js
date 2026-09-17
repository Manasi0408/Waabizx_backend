/**
 * One-time / repeatable DB migration for WhatsApp accounts:
 * - Drops legacy Gupshup / Razorpay / credit-line columns
 * - Backfills ACTIVE status, solution ID, project phone mapping
 *
 * Usage: node scripts/migrate-aisensy-columns.js
 */
require('dotenv').config();
const db = require('../config/db');
const {
  migrateGupshupColumnsToAisensy,
  dropLegacyWhatsAppPaymentColumns,
  backfillWhatsAppAccountData,
} = require('../utils/ensureWhatsAppAccountSchema');

const SCHEMA_COLUMNS = [
  { name: 'business_id', ddl: 'VARCHAR(50) NULL' },
  { name: 'account_status', ddl: "VARCHAR(20) NULL DEFAULT 'INACTIVE'" },
  { name: 'aisensy_solution_id', ddl: 'VARCHAR(50) NULL' },
  { name: 'display_phone', ddl: 'VARCHAR(30) NULL' },
];

async function columnExists(table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return Array.isArray(rows) && rows.length > 0;
}

async function addColumnIfMissing(table, name, ddl) {
  if (await columnExists(table, name)) return;
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  console.log(`[schema] Added ${table}.${name}`);
}

async function printAccountSummary(label) {
  const [cols] = await db.query('SHOW COLUMNS FROM whatsapp_accounts');
  console.log(`\n[${label}] whatsapp_accounts columns:`, cols.map((c) => c.Field).join(', '));

  const [stats] = await db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN account_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN aisensy_solution_id IS NOT NULL AND TRIM(aisensy_solution_id) != '' THEN 1 ELSE 0 END) AS with_solution_id
     FROM whatsapp_accounts`
  );
  console.log(`[${label}] whatsapp_accounts stats:`, stats[0] || {});

  const [sample] = await db.query(
    `SELECT id, client_id, projectId, waba_id, phone_number_id, status, account_status, aisensy_solution_id
     FROM whatsapp_accounts
     ORDER BY id DESC
     LIMIT 5`
  );
  console.log(`[${label}] latest rows:`, JSON.stringify(sample, null, 2));
}

(async () => {
  await printAccountSummary('before');

  await migrateGupshupColumnsToAisensy();
  await dropLegacyWhatsAppPaymentColumns();

  for (const col of SCHEMA_COLUMNS) {
    await addColumnIfMissing('whatsapp_accounts', col.name, col.ddl);
  }

  const backfill = await backfillWhatsAppAccountData();
  console.log('\n[backfill] result:', backfill);

  await printAccountSummary('after');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
