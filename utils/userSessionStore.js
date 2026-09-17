const sequelize = require('../config/database');
const crypto = require('crypto');

let sessionColumnName = null;
let columnEnsured = false;

async function ensureUsersCurrentSessionIdColumn() {
  if (columnEnsured) return sessionColumnName;
  columnEnsured = true;
  try {
    const [rows] = await sequelize.query(
      "SHOW COLUMNS FROM users WHERE Field IN ('currentSessionId', 'current_session_id')"
    );
    const names = new Set((rows || []).map((r) => r.Field));
    if (names.has('currentSessionId')) {
      sessionColumnName = 'currentSessionId';
    } else if (names.has('current_session_id')) {
      sessionColumnName = 'current_session_id';
    } else {
      await sequelize.query(
        'ALTER TABLE users ADD COLUMN currentSessionId VARCHAR(64) NULL DEFAULT NULL'
      );
      sessionColumnName = 'currentSessionId';
    }
  } catch (e) {
    console.warn('[auth] ensureUsersCurrentSessionIdColumn:', e?.message || e);
    sessionColumnName = sessionColumnName || 'currentSessionId';
  }
  return sessionColumnName;
}

async function resolveSessionColumnName() {
  if (sessionColumnName) return sessionColumnName;
  return ensureUsersCurrentSessionIdColumn();
}

async function readUserSessionId(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const col = await resolveSessionColumnName();
  try {
    const [rows] = await sequelize.query(
      `SELECT \`${col}\` AS sid FROM users WHERE id = ? LIMIT 1`,
      { replacements: [uid] }
    );
    const sid = rows?.[0]?.sid;
    return sid != null && String(sid).trim() !== '' ? String(sid).trim() : null;
  } catch (e) {
    console.warn('[auth] readUserSessionId:', e?.message || e);
    return null;
  }
}

async function persistUserSessionId(userId, sessionId) {
  const uid = Number(userId);
  const sid = String(sessionId || '').trim();
  if (!Number.isInteger(uid) || uid <= 0 || !sid) return false;
  const col = await resolveSessionColumnName();
  try {
    await sequelize.query(`UPDATE users SET \`${col}\` = ? WHERE id = ?`, {
      replacements: [sid, uid],
    });
    return true;
  } catch (e) {
    console.warn('[auth] persistUserSessionId:', e?.message || e);
    return false;
  }
}

/** Bind sid when missing (first request after login/register). Returns stored sid. */
async function bindUserSessionIdIfEmpty(userId, sessionId) {
  const uid = Number(userId);
  const sid = String(sessionId || '').trim();
  if (!Number.isInteger(uid) || uid <= 0 || !sid) return null;

  const existing = await readUserSessionId(uid);
  if (existing) return existing;

  const col = await resolveSessionColumnName();
  try {
    const [, metadata] = await sequelize.query(
      `UPDATE users SET \`${col}\` = ? WHERE id = ? AND (\`${col}\` IS NULL OR \`${col}\` = '')`,
      { replacements: [sid, uid] }
    );
    const affected = Number(metadata?.affectedRows ?? metadata) || 0;
    if (affected > 0) return sid;
  } catch (e) {
    console.warn('[auth] bindUserSessionIdIfEmpty:', e?.message || e);
  }

  return readUserSessionId(uid);
}

/**
 * Create a fresh session id, persist it, and verify read-back.
 * Used on login/register so the JWT sid always matches the database.
 */
async function issueUserSession(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error('Invalid user id for session issue');
  }
  await ensureUsersCurrentSessionIdColumn();
  const sessionId = crypto.randomBytes(24).toString('hex');
  const persisted = await persistUserSessionId(uid, sessionId);
  if (!persisted) {
    throw new Error('Failed to persist login session');
  }
  let stored = await readUserSessionId(uid);
  if (stored !== sessionId) {
    await persistUserSessionId(uid, sessionId);
    stored = await readUserSessionId(uid);
  }
  if (stored !== sessionId) {
    throw new Error('Login session verification failed');
  }
  return sessionId;
}

module.exports = {
  ensureUsersCurrentSessionIdColumn,
  readUserSessionId,
  persistUserSessionId,
  bindUserSessionIdIfEmpty,
  issueUserSession,
};
