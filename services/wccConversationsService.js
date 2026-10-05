const db = require('../config/db');
const Project = require('../models/Project');

function n(envKey, def) {
  const v = parseInt(process.env[envKey], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/**
 * Meta-style 24h conversation: bill once per (project_id, customer phone) window.
 * `wcc_conversations` is backend-only — Meta never sends credits.
 *
 * Wallet: matches payment + dashboard (`projects.wcc_credits` per project).
 */

function normalizePhone(value) {
  return String(value || '')
    .trim()
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

async function ensureWccConversationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wcc_conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      user_phone VARCHAR(20) NOT NULL,
      last_conversation_at DATETIME NOT NULL,
      UNIQUE KEY unique_user_project (project_id, user_phone)
    )
  `);
}

async function needsNewConversationBilling(projectId, userPhone) {
  await ensureWccConversationsTable();
  const pid = Number(projectId);
  const phone = normalizePhone(userPhone);
  if (!Number.isInteger(pid) || pid <= 0 || !phone) {
    return false;
  }

  const [rows] = await db.query(
    `SELECT last_conversation_at FROM wcc_conversations
     WHERE project_id = ? AND user_phone = ?
     LIMIT 1`,
    [pid, phone]
  );

  const now = new Date();
  if (!rows || rows.length === 0) {
    return true;
  }

  const lastTime = new Date(rows[0].last_conversation_at);
  const diffHours = (now.getTime() - lastTime.getTime()) / (1000 * 60 * 60);
  return diffHours >= 24;
}

/**
 * After successful Meta send: if new 24h conversation, deduct session credits once and store window.
 */
async function startConversationIfNeeded(projectId, userPhone) {
  await ensureWccConversationsTable();
  await Project.ensureTable();

  const pid = Number(projectId);
  const phone = normalizePhone(userPhone);
  const sessionCredits = n('WCC_META_CONVERSATION_CREDITS', 1);

  if (!Number.isInteger(pid) || pid <= 0 || !phone || sessionCredits <= 0) {
    return { billed: false, reason: 'invalid_input' };
  }

  const ownerUserId = await Project.getProjectOwnerId(pid);
  if (!ownerUserId) {
    return { billed: false, reason: 'no_owner' };
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT last_conversation_at FROM wcc_conversations
       WHERE project_id = ? AND user_phone = ?
       FOR UPDATE`,
      [pid, phone]
    );

    const now = new Date();
    let bill = false;
    if (!rows || rows.length === 0) {
      bill = true;
    } else {
      const lastTime = new Date(rows[0].last_conversation_at);
      const diffHours = (now.getTime() - lastTime.getTime()) / (1000 * 60 * 60);
      bill = diffHours >= 24;
    }

    if (!bill) {
      await conn.commit();
      console.log('Existing 24h session → no WCC session debit', { projectId: pid, phone });
      return { billed: false, reason: 'same_24h_session' };
    }

    const [deductR] = await conn.query(
      `UPDATE projects SET wcc_credits = COALESCE(wcc_credits, 0) - ?
       WHERE id = ? AND COALESCE(wcc_credits, 0) >= ?`,
      [sessionCredits, pid, sessionCredits]
    );

    if (Number(deductR.affectedRows || 0) < 1) {
      await conn.rollback();
      console.error('WCC: insufficient credits for new session', {
        projectId: pid,
        phone,
        need: sessionCredits,
      });
      return { billed: false, reason: 'deduct_failed' };
    }

    if (!rows || rows.length === 0) {
      await conn.query(
        `INSERT INTO wcc_conversations (project_id, user_phone, last_conversation_at)
         VALUES (?, ?, ?)`,
        [pid, phone, now]
      );
      console.log('New WCC 24h session (first) — debited credits', sessionCredits, {
        projectId: pid,
        phone,
      });
    } else {
      await conn.query(
        `UPDATE wcc_conversations SET last_conversation_at = ?
         WHERE project_id = ? AND user_phone = ?`,
        [now, pid, phone]
      );
      console.log('New WCC 24h session (after 24h) — debited credits', sessionCredits, {
        projectId: pid,
        phone,
      });
    }

    await conn.commit();
    return { billed: true, credits: sessionCredits };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureWccConversationsTable,
  normalizePhone,
  needsNewConversationBilling,
  startConversationIfNeeded,
};
