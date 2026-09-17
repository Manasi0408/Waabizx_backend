const db = require('../config/db');
const { phoneVariantsForLookup, normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');

let hasConversationProjectIdColumn = null;

async function supportsConversationProjectId() {
  if (hasConversationProjectIdColumn != null) return hasConversationProjectIdColumn;
  try {
    const [rows] = await db.query("SHOW COLUMNS FROM conversations LIKE 'project_id'");
    if (Array.isArray(rows) && rows.length > 0) {
      hasConversationProjectIdColumn = true;
      return true;
    }
    await db.query('ALTER TABLE conversations ADD COLUMN project_id INT NULL');
    hasConversationProjectIdColumn = true;
  } catch (e) {
    hasConversationProjectIdColumn = false;
  }
  return hasConversationProjectIdColumn;
}

/**
 * Find latest open conversation for phone (any common phone format) scoped to project when possible.
 */
async function findOpenConversation(phone, projectId = null) {
  const variants = phoneVariantsForLookup(phone);
  if (variants.length === 0) return null;

  const placeholders = variants.map(() => '?').join(',');
  const useProject = await supportsConversationProjectId();
  const pid = projectId != null && Number(projectId) > 0 ? Number(projectId) : null;

  let sql;
  let params;
  if (useProject && pid) {
    sql = `SELECT id, agent_id, status, phone, project_id
           FROM conversations
           WHERE phone IN (${placeholders})
             AND LOWER(TRIM(COALESCE(status,''))) != 'closed'
             AND (project_id <=> ? OR project_id IS NULL)
           ORDER BY CASE WHEN project_id <=> ? THEN 0 ELSE 1 END ASC, id DESC
           LIMIT 1`;
    params = [...variants, pid, pid];
  } else {
    sql = `SELECT id, agent_id, status, phone, project_id
           FROM conversations
           WHERE phone IN (${placeholders})
             AND LOWER(TRIM(COALESCE(status,''))) != 'closed'
           ORDER BY id DESC
           LIMIT 1`;
    params = variants;
  }

  const [rows] = await db.query(sql, params);
  return rows && rows[0] ? rows[0] : null;
}

/**
 * AiSensy-style routing:
 * - No agent assigned → requesting
 * - Agent assigned + intervened → stay intervened
 * - Agent assigned + active → stay active
 */
async function syncInboundToConversation({
  phone,
  text = '',
  projectId = null,
  customerName = null,
  createdAt = null,
}) {
  const normalizedPhone = normalizeWhatsAppRecipient(phone) || String(phone || '').trim();
  if (!normalizedPhone) {
    return { conversationId: null, agentId: null, status: null };
  }

  const displayName = String(customerName || normalizedPhone).trim() || normalizedPhone;
  const messageText = String(text || '').trim();
  const ts = createdAt ? new Date(createdAt) : new Date();
  const pid = projectId != null && Number(projectId) > 0 ? Number(projectId) : null;
  const useProject = await supportsConversationProjectId();

  let conv = await findOpenConversation(normalizedPhone, pid);
  let convId;

  if (!conv) {
    if (useProject && pid) {
      const [ins] = await db.query(
        `INSERT INTO conversations (phone, customer_name, last_message, status, project_id)
         VALUES (?, ?, ?, 'requesting', ?)`,
        [normalizedPhone, displayName, messageText, pid]
      );
      convId = ins.insertId;
    } else {
      const [ins] = await db.query(
        `INSERT INTO conversations (phone, customer_name, last_message, status)
         VALUES (?, ?, ?, 'requesting')`,
        [normalizedPhone, displayName, messageText]
      );
      convId = ins.insertId;
    }
    conv = { id: convId, agent_id: null, status: 'requesting' };
  } else {
    convId = conv.id;
  }

  if (messageText) {
    await db.query(
      'INSERT INTO message (conversation_id, sender, message, created_at) VALUES (?, ?, ?, ?)',
      [convId, 'customer', messageText, ts]
    );
  }

  const agentId = conv.agent_id != null ? Number(conv.agent_id) : null;
  const statusSql = agentId == null
    ? `'requesting'`
    : `CASE WHEN LOWER(TRIM(COALESCE(status,''))) = 'intervened' THEN 'intervened' ELSE status END`;

  if (useProject && pid) {
    await db.query(
      `UPDATE conversations SET
         last_message = ?,
         customer_name = COALESCE(NULLIF(?, ''), customer_name),
         phone = ?,
         project_id = COALESCE(project_id, ?),
         status = ${statusSql}
       WHERE id = ?`,
      [messageText || conv.last_message || '', displayName, normalizedPhone, pid, convId]
    );
  } else {
    await db.query(
      `UPDATE conversations SET
         last_message = ?,
         customer_name = COALESCE(NULLIF(?, ''), customer_name),
         phone = ?,
         status = ${statusSql}
       WHERE id = ?`,
      [messageText || conv.last_message || '', displayName, normalizedPhone, convId]
    );
  }

  const [updated] = await db.query(
    'SELECT id, agent_id, status, phone, project_id FROM conversations WHERE id = ? LIMIT 1',
    [convId]
  );
  const row = updated && updated[0] ? updated[0] : conv;

  return {
    conversationId: convId,
    agentId: row.agent_id != null ? Number(row.agent_id) : null,
    status: String(row.status || 'requesting').toLowerCase(),
    phone: row.phone || normalizedPhone,
  };
}

/**
 * Mirror outbound agent sends (templates, etc.) into live-chat `message` rows
 * so /api/chat/messages can merge them with enriched inbox template cards.
 */
async function syncOutboundToConversation({ phone, text, projectId, createdAt = null }) {
  const normalizedPhone = normalizeWhatsAppRecipient(phone) || String(phone || '').trim();
  if (!normalizedPhone) return null;

  const pid = projectId != null && Number(projectId) > 0 ? Number(projectId) : null;
  const conv = await findOpenConversation(normalizedPhone, pid);
  if (!conv?.id) return null;

  const messageText = String(text || '').trim();
  if (!messageText) return conv.id;

  const ts = createdAt ? new Date(createdAt) : new Date();
  await db.query(
    'INSERT INTO message (conversation_id, sender, message, created_at) VALUES (?, ?, ?, ?)',
    [conv.id, 'agent', messageText, ts]
  );
  await db.query('UPDATE conversations SET last_message = ? WHERE id = ?', [messageText, conv.id]);
  return conv.id;
}

module.exports = {
  supportsConversationProjectId,
  findOpenConversation,
  syncInboundToConversation,
  syncOutboundToConversation,
};
