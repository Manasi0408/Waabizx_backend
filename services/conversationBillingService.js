const db = require('../config/db');

/**
 * Tracks 24-hour service conversations per account + phone in `realconversation`.
 * - `wasNew: true`  → first message in a new 24h session for that pair (WCC session charge applies).
 * - `wasNew: false` → session already open; only `last_message_at` is bumped (no WCC session charge).
 */

const DEFAULT_CONVERSATION_LIMIT = 10000;

const ensureAccountExists = async (accountId) => {
  const id = Number(accountId);
  if (!id || Number.isNaN(id)) {
    return { limit: DEFAULT_CONVERSATION_LIMIT, created: false, name: null };
  }

  const [rows] = await db.query(
    'SELECT id, conversation_limit, name FROM accounts WHERE id = ? LIMIT 1',
    [id]
  );
  if (rows && rows.length > 0) {
    return {
      limit: Number(rows[0].conversation_limit) || DEFAULT_CONVERSATION_LIMIT,
      created: false,
      name: rows[0].name || null,
    };
  }

  // Create an account record on-demand so quota works without needing migrations/seeding.
  // We explicitly set `id` to match `accountId` used by the app.
  await db.query(
    'INSERT INTO accounts (id, name, conversation_limit) VALUES (?, ?, ?)',
    [id, `Account ${id}`, DEFAULT_CONVERSATION_LIMIT]
  );

  return { limit: DEFAULT_CONVERSATION_LIMIT, created: true, name: `Account ${id}` };
};

const normalizePhone = (value) => String(value || '').trim().replace(/^\+/, '');

const getActiveConversation = async (accountId, phone) => {
  const normalizedPhone = normalizePhone(phone);
  const [rows] = await db.query(
    `SELECT *
     FROM realconversation
     WHERE account_id = ?
       AND phone = ?
       AND is_active = 1
       AND last_message_at >= NOW() - INTERVAL 24 HOUR
     ORDER BY id DESC
     LIMIT 1`,
    [accountId, normalizedPhone]
  );

  return rows && rows.length > 0 ? rows[0] : null;
};

const getUsedConversations = async (accountId) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) as total
     FROM realconversation
     WHERE account_id = ?
       AND is_active = 1
       AND conversation_start >= NOW() - INTERVAL 24 HOUR`,
    [accountId]
  );

  const total = rows && rows.length > 0 ? Number(rows[0].total) : 0;
  return total;
};

const upsertConversationWithQuota = async (accountId, phone) => {
  const { limit } = await ensureAccountExists(accountId);
  const normalizedPhone = normalizePhone(phone);
  const active = await getActiveConversation(accountId, normalizedPhone);

  if (active) {
    // Same conversation: free (only rolling activity forward)
    await db.query(
      'UPDATE realconversation SET last_message_at = NOW(), is_active = 1 WHERE id = ?',
      [active.id]
    );
    return { allowed: true, wasNew: false, conversationId: active.id, used: null, limit };
  }

  // New 24-hour conversation: check limit before inserting.
  const used = await getUsedConversations(accountId);
  if (used >= limit) {
    return { allowed: false, wasNew: true, conversationId: null, used, limit };
  }

  const [result] = await db.query(
    `INSERT INTO realconversation (account_id, phone, conversation_start, last_message_at, is_active)
     VALUES (?, ?, NOW(), NOW(), 1)`,
    [accountId, normalizedPhone]
  );

  return { allowed: true, wasNew: true, conversationId: result.insertId, used, limit };
};

module.exports = {
  upsertConversationWithQuota,
  getUsedConversations,
  ensureAccountExists,
};

