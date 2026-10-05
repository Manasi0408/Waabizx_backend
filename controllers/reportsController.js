const { sequelize } = require('../models');
const { requireProjectId } = require('../utils/projectScope');
const {
  ALLOWED_DISPOSITIONS,
  normalizeDisposition,
  getDispositionLabel,
  DISPOSITION_LABELS,
} = require('../utils/resolveDispositions');

const ensureDispositionColumns = async () => {
  try {
    const [cols] = await sequelize.query(`SHOW COLUMNS FROM conversations LIKE 'disposition'`);
    if (!Array.isArray(cols) || cols.length === 0) {
      await sequelize.query(
        `ALTER TABLE conversations ADD COLUMN disposition VARCHAR(64) NULL`
      );
    }
  } catch (e) {
    console.error('Could not ensure conversations.disposition:', e?.message || e);
  }
  try {
    const [atCols] = await sequelize.query(
      `SHOW COLUMNS FROM conversations LIKE 'disposition_updated_at'`
    );
    if (!Array.isArray(atCols) || atCols.length === 0) {
      await sequelize.query(
        `ALTER TABLE conversations ADD COLUMN disposition_updated_at DATETIME NULL`
      );
    }
  } catch (e) {
    console.error('Could not ensure conversations.disposition_updated_at:', e?.message || e);
  }
};

const projectScopeSql = `
  (
    c.project_id = :projectId
    OR (
      c.project_id IS NULL
      AND EXISTS (
        SELECT 1 FROM contacts ct
        WHERE ct.projectId = :projectId
          AND REPLACE(REPLACE(REPLACE(ct.phone, '+', ''), ' ', ''), '-', '')
            = REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', '')
      )
    )
  )
`;

/**
 * Intervened report by date.
 * For each agent (users.role='agent'), count messages sent in conversations
 * where conversations.status='intervened' on the provided date.
 */
exports.getIntervenedReport = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const dateStr = String(req.query.date || '').trim();
    const date = dateStr || new Date().toISOString().slice(0, 10);

    // NOTE:
    // In this DB, `agent_conversations` exists but does NOT contain `assigned_agent`.
    // So we rely only on conversations.agent_id to avoid SQL errors.

    const agents = await sequelize.query(
      `
      SELECT
        u.id AS agentId,
        COALESCE(u.name, u.email, CONCAT('User ', u.id)) AS agentName,
        COUNT(c.id) AS intervenedConversations,
        COUNT(c.id) AS intervenedMessages
      FROM users u
      LEFT JOIN conversations c
        ON c.agent_id = u.id
       AND LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
       AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
      WHERE u.role IN ('agent','admin')
        AND u.projectId = :projectId
      GROUP BY u.id, u.name, u.email
      ORDER BY intervenedMessages DESC, intervenedConversations DESC
      `,
      {
        replacements: { date, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const total = await sequelize.query(
      `
      SELECT
        COUNT(c.id) AS totalIntervenedConversations,
        COUNT(c.id) AS totalIntervenedMessages
      FROM conversations c
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
        AND c.agent_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = c.agent_id
            AND u.projectId = :projectId
        )
        AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
      `,
      {
        replacements: { date, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const t = total?.[0] || {};

    res.json({
      success: true,
      date,
      total: {
        intervenedMessages: Number(t.totalIntervenedMessages || 0),
        intervenedConversations: Number(t.totalIntervenedConversations || 0),
      },
      agents: (agents || []).map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        intervenedMessages: Number(a.intervenedMessages || 0),
        intervenedConversations: Number(a.intervenedConversations || 0),
      })),
    });
  } catch (e) {
    console.error('getIntervenedReport error:', e);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

exports.exportIntervenedReport = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const dateStr = String(req.query.date || '').trim();
    const date = dateStr || new Date().toISOString().slice(0, 10);
    const agentIdRaw = req.query.agentId;
    const agentId = agentIdRaw != null && String(agentIdRaw).trim() !== ''
      ? Number(agentIdRaw)
      : null;

    const rows = await sequelize.query(
      `
      SELECT
        COALESCE(NULLIF(TRIM(c.customer_name), ''), NULLIF(TRIM(c.phone), ''), 'N/A') AS customer_name,
        COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A') AS phone
      FROM conversations c
      JOIN users u
        ON u.id = c.agent_id
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
        AND u.role IN ('agent','admin')
        AND u.projectId = :projectId
        AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
        AND (:agentId IS NULL OR c.agent_id = :agentId)
      ORDER BY c.id DESC
      `,
      {
        replacements: { date, agentId, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const escapeCsv = (value) => {
      const s = value == null ? '' : String(value);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header = 'customer_name,phone';
    const lines = (rows || []).map((r) =>
      `${escapeCsv(r.customer_name)},${escapeCsv(r.phone)}`
    );
    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=\"intervened-report-${date}.csv\"`
    );
    return res.status(200).send(csv);
  } catch (e) {
    console.error('exportIntervenedReport error:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

exports.getIntervenedCustomerReport = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const dateStr = String(req.query.date || '').trim();
    const date = dateStr || new Date().toISOString().slice(0, 10);

    const agentIdRaw = req.query.agentId;
    const adminIdRaw = req.query.adminId;

    const agentId =
      agentIdRaw != null && String(agentIdRaw).trim() !== ''
        ? Number(agentIdRaw)
        : null;
    const adminId =
      adminIdRaw != null && String(adminIdRaw).trim() !== ''
        ? Number(adminIdRaw)
        : null;

    const customers = await sequelize.query(
      `
      SELECT
        MAX(
          COALESCE(
            NULLIF(TRIM(c.customer_name), ''),
            NULLIF(TRIM(c.phone), ''),
            'N/A'
          )
        ) AS customer_name,
        COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A') AS phone,
        COUNT(DISTINCT c.id) AS intervened_conversations_count
      FROM conversations c
      JOIN users u
        ON u.id = c.agent_id
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
        AND u.role IN ('agent','admin')
        AND u.projectId = :projectId
        AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
        AND (
          (:agentId IS NULL AND :adminId IS NULL)
          OR c.agent_id = :agentId
          OR c.agent_id = :adminId
        )
      GROUP BY COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A')
      ORDER BY intervened_conversations_count DESC
      `,
      {
        replacements: { date, agentId, adminId, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const total = await sequelize.query(
      `
      SELECT
        COUNT(DISTINCT c.id) AS totalIntervenedConversations
      FROM conversations c
      JOIN users u
        ON u.id = c.agent_id
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
        AND u.role IN ('agent','admin')
        AND u.projectId = :projectId
        AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
        AND (
          (:agentId IS NULL AND :adminId IS NULL)
          OR c.agent_id = :agentId
          OR c.agent_id = :adminId
        )
      `,
      {
        replacements: { date, agentId, adminId, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const t = total?.[0] || {};

    return res.json({
      success: true,
      date,
      totalIntervenedConversations: Number(t.totalIntervenedConversations || 0),
      customers: (customers || []).map((c) => ({
        customerName: c.customer_name,
        phone: c.phone,
        intervenedConversationsCount: Number(c.intervened_conversations_count || 0),
      })),
    });
  } catch (e) {
    console.error('getIntervenedCustomerReport error:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

exports.exportIntervenedCustomerReport = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const dateStr = String(req.query.date || '').trim();
    const date = dateStr || new Date().toISOString().slice(0, 10);

    const agentIdRaw = req.query.agentId;
    const adminIdRaw = req.query.adminId;

    const agentId =
      agentIdRaw != null && String(agentIdRaw).trim() !== ''
        ? Number(agentIdRaw)
        : null;
    const adminId =
      adminIdRaw != null && String(adminIdRaw).trim() !== ''
        ? Number(adminIdRaw)
        : null;

    const rows = await sequelize.query(
      `
      SELECT
        MAX(
          COALESCE(
            NULLIF(TRIM(c.customer_name), ''),
            NULLIF(TRIM(c.phone), ''),
            'N/A'
          )
        ) AS customer_name,
        COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A') AS phone,
        COUNT(DISTINCT c.id) AS intervened_conversations_count
      FROM conversations c
      JOIN users u
        ON u.id = c.agent_id
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
        AND u.role IN ('agent','admin')
        AND u.projectId = :projectId
        AND DATE(COALESCE(c.created_at, c.last_message_time)) = :date
        AND (
          (:agentId IS NULL AND :adminId IS NULL)
          OR c.agent_id = :agentId
          OR c.agent_id = :adminId
        )
      GROUP BY COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A')
      ORDER BY intervened_conversations_count DESC
      `,
      {
        replacements: { date, agentId, adminId, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const escapeCsv = (value) => {
      const s = value == null ? '' : String(value);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header = 'customer_name,phone,intervened_conversations_count';
    const lines = (rows || []).map((r) => {
      const customerName = r.customer_name;
      const phone = r.phone;
      const count = r.intervened_conversations_count;
      return `${escapeCsv(customerName)},${escapeCsv(phone)},${escapeCsv(count)}`;
    });
    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=\"intervened-customers-${date}.csv\"`
    );
    return res.status(200).send(csv);
  } catch (e) {
    console.error('exportIntervenedCustomerReport error:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

/**
 * Lead disposition report — closed conversations with a disposition for the project/date.
 */
exports.getDispositionReport = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    await ensureDispositionColumns();

    const dateStr = String(req.query.date || '').trim();
    const date = dateStr || new Date().toISOString().slice(0, 10);

    const leads = await sequelize.query(
      `
      SELECT
        c.id AS conversationId,
        COALESCE(
          NULLIF(TRIM(c.customer_name), ''),
          NULLIF(TRIM(c.phone), ''),
          'N/A'
        ) AS leadName,
        COALESCE(NULLIF(TRIM(c.phone), ''), 'N/A') AS phone,
        LOWER(TRIM(COALESCE(c.disposition, ''))) AS disposition,
        c.agent_id AS agentId,
        (
          SELECT COALESCE(NULLIF(TRIM(u.name), ''), NULLIF(TRIM(u.email), ''), CONCAT('Agent #', u.id))
          FROM users u WHERE u.id = c.agent_id LIMIT 1
        ) AS agentName,
        COALESCE(c.disposition_updated_at, c.last_message_time, c.created_at) AS dispositionAt
      FROM conversations c
      WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'closed'
        AND c.disposition IS NOT NULL
        AND TRIM(c.disposition) <> ''
        AND ${projectScopeSql}
        AND DATE(COALESCE(c.disposition_updated_at, c.last_message_time, c.created_at)) = :date
      ORDER BY COALESCE(c.disposition_updated_at, c.last_message_time, c.created_at) DESC, c.id DESC
      `,
      {
        replacements: { date, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const byType = {};
    for (const key of ALLOWED_DISPOSITIONS) {
      byType[key] = { disposition: key, label: getDispositionLabel(key), count: 0 };
    }
    for (const row of leads || []) {
      const key = normalizeDisposition(row.disposition);
      if (byType[key]) byType[key].count += 1;
      else {
        byType[key] = {
          disposition: key,
          label: getDispositionLabel(key),
          count: 1,
        };
      }
    }

    return res.json({
      success: true,
      date,
      totalLeads: (leads || []).length,
      byType: Object.values(byType).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      leads: (leads || []).map((r) => ({
        conversationId: r.conversationId,
        leadName: r.leadName,
        phone: r.phone,
        disposition: normalizeDisposition(r.disposition),
        dispositionLabel: getDispositionLabel(r.disposition),
        agentId: r.agentId != null ? Number(r.agentId) : null,
        agentName: r.agentName || null,
        dispositionAt: r.dispositionAt || null,
      })),
      dispositionOptions: Object.entries(DISPOSITION_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    });
  } catch (e) {
    console.error('getDispositionReport error:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

/**
 * Admin/manager: update disposition on a closed lead conversation.
 */
exports.updateLeadDisposition = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const role = String(req.user?.role || '').toLowerCase();
    if (!['admin', 'manager', 'super_admin'].includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Only admin or manager can edit lead disposition',
      });
    }

    const conversationId = Number(req.params.id || req.body?.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid conversation id is required',
      });
    }

    const dispositionRaw = normalizeDisposition(req.body?.disposition);
    if (!dispositionRaw || !ALLOWED_DISPOSITIONS.has(dispositionRaw)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid disposition type',
      });
    }

    await ensureDispositionColumns();

    let rows = await sequelize.query(
      `
      SELECT c.id, c.disposition, c.project_id
      FROM conversations c
      WHERE c.id = :conversationId
        AND ${projectScopeSql}
      LIMIT 1
      `,
      {
        replacements: { conversationId, projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    // Fallback: conversation may have null/legacy project_id but still belong to this workspace.
    if (!rows?.[0]) {
      rows = await sequelize.query(
        `
        SELECT c.id, c.disposition, c.project_id
        FROM conversations c
        WHERE c.id = :conversationId
        LIMIT 1
        `,
        {
          replacements: { conversationId },
          type: sequelize.QueryTypes.SELECT,
        }
      );
      if (rows?.[0] && rows[0].project_id != null && Number(rows[0].project_id) !== Number(projectId)) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found for this project',
        });
      }
    }

    if (!rows?.[0]) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found for this project',
      });
    }

    await sequelize.query(
      `
      UPDATE conversations
      SET disposition = :disposition,
          disposition_updated_at = NOW(),
          status = 'closed',
          project_id = COALESCE(project_id, :projectId)
      WHERE id = :conversationId
      `,
      {
        replacements: { disposition: dispositionRaw, conversationId, projectId },
      }
    );

    return res.json({
      success: true,
      conversationId,
      disposition: dispositionRaw,
      dispositionLabel: getDispositionLabel(dispositionRaw),
      message: 'Disposition updated',
    });
  } catch (e) {
    console.error('updateLeadDisposition error:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: e?.message || String(e),
    });
  }
};

