const db = require("../config/db");
const { Op } = require("sequelize");
const { Contact, Message, InboxMessage, User, Template } = require("../models");
const Project = require("../models/Project");
const socketService = require("../services/socketService");
const { sendText } = require("../services/whatsappService");
const {
  postWhatsAppTemplateMessage,
  resolveWhatsAppSendCredentialCandidates,
} = require('../utils/metaWhatsAppCredentials');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('../services/wccMetaChargeService');
const { recordOutboundInboxMessage } = require('../services/outboundInboxService');
const { syncInboundToConversation } = require('../services/conversationInboxService');
const { loadTemplateRecordForCampaign, resolveTemplateComponentsForSend } = require('../services/metaTemplateFetchService');
const { dedupeInboxMessages, messageHasTemplateCard, messagesMatchForDedupe } = require('../utils/mergeInboxMessages');
const { enrichInboxMessageForClient, extractTemplateNameFromBody } = require('../utils/inboxMessageApiUtil');
const { isTemplateMarkerContent, buildTemplateCatalogMap, buildClientTemplatePreview, applyTemplateParamsToBody } = require('../utils/templatePreviewUtil');
const { phoneVariantsForLookup } = require('../utils/phoneNormalize');
const {
  ALLOWED_DISPOSITIONS,
  normalizeDisposition,
  getDispositionLabel,
} = require('../utils/resolveDispositions');

// Defaults shown in the Opt-in Management UI
const OPT_IN_MESSAGE =
  'Thanks! You have been opted in for future marketing messages. You will now receive updates and notifications related to this project.';
const OPT_OUT_MESSAGE =
  'You have been opted out of your future marketing messages. If you would like to receive messages again, reply APPLY above US/APPLY.';

// Shared list shape for Live Chat / Inbox sections
const conversationListFields = `
  c.id,
  c.phone,
  COALESCE(
    NULLIF(
      TRIM(
        CASE
          WHEN c.customer_name IS NOT NULL
            AND TRIM(c.customer_name) <> ''
            AND REPLACE(REPLACE(REPLACE(TRIM(c.customer_name), '+', ''), ' ', ''), '-', '')
              <> REPLACE(REPLACE(REPLACE(TRIM(c.phone), '+', ''), ' ', ''), '-', '')
          THEN c.customer_name
          ELSE NULL
        END
      ),
      ''
    ),
    (
      SELECT NULLIF(TRIM(ct.name), '')
      FROM contacts ct
      WHERE REPLACE(REPLACE(REPLACE(ct.phone, '+', ''), ' ', ''), '-', '')
        = REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', '')
        AND TRIM(COALESCE(ct.name, '')) <> ''
        AND REPLACE(REPLACE(REPLACE(ct.name, '+', ''), ' ', ''), '-', '')
          <> REPLACE(REPLACE(REPLACE(c.phone, '+', ''), ' ', ''), '-', '')
      LIMIT 1
    ),
    c.phone
  ) AS customer_name,
  c.last_message,
  c.status,
  c.agent_id,
  (SELECT COALESCE(NULLIF(TRIM(u.name), ''), NULLIF(TRIM(u.email), ''), CONCAT('Agent #', u.id))
   FROM users u WHERE u.id = c.agent_id LIMIT 1) AS agent_name,
  (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id) AS last_message_time,
  0 AS unread_count
`;

const lastMessageWithin24h = `
  TIMESTAMPDIFF(
    HOUR,
    (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id),
    NOW()
  ) < 24
`;

const lastMessageOlderThan24h = `
  TIMESTAMPDIFF(
    HOUR,
    (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id),
    NOW()
  ) >= 24
`;

const customerHasRepliedSql = `
  (
    EXISTS (
      SELECT 1 FROM message m
      WHERE m.conversation_id = c.id
        AND LOWER(TRIM(COALESCE(m.sender,''))) = 'customer'
    )
    OR EXISTS (
      SELECT 1 FROM inboxmessages im
      INNER JOIN contacts ct ON ct.id = im.contactId
      WHERE im.direction = 'incoming'
        AND im.projectId = c.project_id
        AND REPLACE(REPLACE(REPLACE(TRIM(ct.phone), '+', ''), ' ', ''), '-', '')
          = REPLACE(REPLACE(REPLACE(TRIM(c.phone), '+', ''), ' ', ''), '-', '')
    )
  )
`;

const projectScopeSql = `c.project_id = ?`;

const getProjectIdFromReq = (req) => {
  const n = Number(
    req?.projectId ??
      req?.headers?.['x-project-id'] ??
      req?.headers?.['x_project_id'] ??
      req?.user?.projectId ??
      null
  );
  return Number.isInteger(n) && n > 0 ? n : null;
};
const phoneVariants = (phone) => {
  const raw = String(phone || "").trim();
  if (!raw) return [];
  const noPlus = raw.replace(/^\+/, "");
  return [...new Set([raw, noPlus, `+${noPlus}`])];
};

async function loadTemplateForProject({ templateName, userId, projectId }) {
  const ownerId = await Project.getProjectOwnerId(projectId);
  const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
  let record = await Template.findOne({
    where: {
      projectId,
      userId: { [Op.in]: userIds },
      name: templateName,
      [Op.or]: [{ status: 'approved' }, { metaStatus: 'APPROVED' }],
    },
  });
  if (!record) {
    record = await loadTemplateRecordForCampaign({
      userId: ownerId || userId,
      projectId,
      templateName,
    });
  }
  return record;
}

function normalizeTemplateParams(templateParams) {
  if (Array.isArray(templateParams)) return templateParams;
  if (typeof templateParams === 'string') {
    try {
      const parsed = JSON.parse(templateParams);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (templateParams && typeof templateParams === 'object') {
    return Object.values(templateParams);
  }
  return [];
}

const resolveDefaultProjectId = async () => {
  try {
    const [rows] = await db.query("SELECT id FROM projects ORDER BY id ASC LIMIT 1");
    if (Array.isArray(rows) && rows.length > 0 && rows[0].id != null) return Number(rows[0].id);
  } catch (e) {}
  return 1;
};

const assertConversationInProject = async (conversationId, projectId) => {
  const [rows] = await db.query(
    `SELECT c.id
     FROM conversations c
     WHERE c.id = ?
       AND c.project_id = ?
     LIMIT 1`,
    [conversationId, projectId]
  );
  return Array.isArray(rows) && rows.length > 0;
};

exports.receiveMessage = async (req, res) => {
  try {
    const phone = req.body.phone;
    const message = req.body.message;
    const variants = phoneVariants(phone);
    let projectId = Number(req.body.project_id || req.body.projectId || 0) || null;

    if (!projectId && variants.length > 0) {
      const [existingProjectRows] = await db.query(
        `SELECT project_id FROM conversations
         WHERE phone IN (?) AND project_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [variants]
      );
      if (Array.isArray(existingProjectRows) && existingProjectRows.length > 0) {
        projectId = Number(existingProjectRows[0].project_id);
      }
    }
    if (!projectId && variants.length > 0) {
      const [mappingRows] = await db.query(
        `SELECT project_id FROM clients_whatsapp
         WHERE phone IN (?) AND project_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [variants]
      );
      if (Array.isArray(mappingRows) && mappingRows.length > 0) {
        projectId = Number(mappingRows[0].project_id);
      }
    }
    if (!projectId) {
      projectId = await resolveDefaultProjectId();
    }

    const synced = await syncInboundToConversation({
      phone,
      text: message,
      projectId,
      customerName: phone,
    });
    const convId = synced.conversationId;

    // Sync to inbox (Contact + Message + InboxMessage) so /inbox shows customer messages too
    try {
      const normalizedPhone = (phone || "").toString().trim();
      if (normalizedPhone) {
        const normalizedText = (message || "").toString().trim().toUpperCase();
        const isOptOut =
          normalizedText === 'STOP' ||
          normalizedText === 'UNSUBSCRIBE' ||
          normalizedText === 'CANCEL';
        const isOptInKeyword = normalizedText === 'START' || normalizedText === 'YES' || normalizedText === 'HI';

        let contact = await Contact.findOne({ where: { phone: normalizedPhone, projectId } });
        const wasNewContact = !contact;
        const oldOptedOut = contact
          ? contact.status === "unsubscribed" || !contact.whatsappOptInAt
          : false;
        if (!contact) {
          const firstUser = await User.findOne({
            where: { status: "active" },
            order: [["id", "ASC"]],
            attributes: ["id", "projectId"],
          });
          if (firstUser) {
            contact = await Contact.create({
              userId: firstUser.id,
              projectId: projectId || firstUser.projectId || null,
              phone: normalizedPhone,
              name: normalizedPhone,
              status: isOptOut ? "unsubscribed" : "active",
              whatsappOptInAt: isOptOut ? null : new Date(),
            });
          }
        }

        // Update consent state for existing contacts
        if (contact) {
          if (isOptOut) {
            await contact.update({ status: "unsubscribed", whatsappOptInAt: null });
          } else if (isOptInKeyword && !contact.whatsappOptInAt) {
            await contact.update({ status: "active", whatsappOptInAt: new Date() });
          } else if (wasNewContact && contact.status !== "unsubscribed" && !contact.whatsappOptInAt) {
            // Safety net: new contact should be opted in on first non-STOP message
            await contact.update({ status: "active", whatsappOptInAt: new Date() });
          }

          // Auto-reply on first consent change
          try {
            if (isOptOut && !oldOptedOut) {
              await sendText(normalizedPhone, OPT_OUT_MESSAGE);
            }
          } catch (e) {
            console.error("Auto reply sendText failed (chat webhook):", e?.message || e);
          }
        }

        if (contact) {
          await Message.create({
            contactId: contact.id,
            content: message,
            type: "incoming",
            status: "delivered",
            sentAt: new Date(),
          });
          await InboxMessage.create({
            contactId: contact.id,
            userId: contact.userId,
            projectId,
            direction: "incoming",
            message: message,
            type: "text",
            status: "delivered",
            timestamp: new Date(),
          });
          await contact.update({ lastContacted: new Date() });

          // Ensure conversations.customer_name is never NULL/blank.
          // Prefer contact.name, fallback to phone.
          await db.query(
            "UPDATE conversations SET customer_name=? WHERE id=?",
            [contact.name || normalizedPhone, convId]
          );
          try {
            socketService.emitToUser(contact.userId, "inbox-update", { contactId: contact.id });
            socketService.emitToManager("inbox-update", { contactId: contact.id });
          } catch (e) {}
        }
      }
    } catch (inboxErr) {
      console.error("Error syncing receiveMessage to inbox:", inboxErr);
    }

    res.json({ message: "Message received" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Manager Inbox: all requesting conversations for this project (assigned + unassigned)
exports.getManagerRequesting = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    // Requesting queue only — never mix active/intervened into this list
    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'requesting'
         AND c.project_id = ?
         AND ${customerHasRepliedSql}
       ORDER BY last_message_time DESC`,
      [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Agent Requesting Tab: conversations assigned to this agent with status=requesting
exports.getAgentRequesting = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const agentId = req.query.agentId;
    if (!agentId) {
      return res.status(400).json({ error: "agentId query is required" });
    }
    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE c.agent_id = ? AND LOWER(TRIM(COALESCE(c.status,''))) = 'requesting'
         AND c.project_id = ?
         AND ${customerHasRepliedSql}
       ORDER BY last_message_time DESC`,
      [agentId, projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 1️⃣ MANAGER: see all conversations (any status)
exports.getManagerConversations = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE c.project_id = ?
       ORDER BY last_message_time DESC`
      , [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Generic: fetch chats only for a project_id
exports.getConversationsByProject = async (req, res) => {
  try {
    const projectId = Number(req.params.projectId || 0);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, error: "Valid projectId is required" });
    }
    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE c.project_id = ?
       ORDER BY last_message_time DESC`,
      [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 2️⃣ AGENT: see only conversations assigned to this agent_id (other agents' intervened chats not visible)
const getCurrentUser = (req) => {
  const u = req.user;
  if (!u) return { id: null, role: "" };
  const id = u.id != null ? Number(u.id) : (u.dataValues && u.dataValues.id != null ? Number(u.dataValues.id) : null);
  const role = (u.role != null ? String(u.role) : (u.dataValues && u.dataValues.role != null ? String(u.dataValues.role) : "")) || "";
  return { id, role };
};

exports.getAgentConversations = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ success: false, message: "Project is required" });
    const { id: agentId } = getCurrentUser(req);

    if (agentId == null) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: missing authenticated user",
      });
    }

    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE c.agent_id = ?
         AND LOWER(TRIM(COALESCE(c.status,''))) IN ('active','intervened')
         AND c.project_id = ?
       ORDER BY last_message_time DESC`,
      [agentId, projectId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const isAgentRole = (role) => (role || "").toString().toLowerCase() === "agent";
const isManagerRole = (role) => ["admin", "manager"].includes((role || "").toString().toLowerCase());

const formatAgentDisplayName = (userRow) => {
  const name = String(userRow?.name || userRow?.email || `Agent ${userRow?.id || ""}`).trim();
  return name.toUpperCase();
};

async function fetchUserDisplayName(userId) {
  if (!userId) return "AGENT";
  const [rows] = await db.query(
    "SELECT id, name, email FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return formatAgentDisplayName(rows?.[0] || {});
}

async function recordChatSystemMessage(conversationId, text) {
  const body = String(text || "").trim();
  if (!conversationId || !body) return null;
  let insertId = null;
  try {
    const [result] = await db.query(
      "INSERT INTO message (conversation_id, sender, message) VALUES (?, 'system', ?)",
      [conversationId, body]
    );
    insertId = result?.insertId || null;
    await db.query("UPDATE conversations SET last_message = ? WHERE id = ?", [
      body,
      conversationId,
    ]);
  } catch (err) {
    // Still return a client-visible banner even if DB insert fails (e.g. sender ENUM)
    console.error("recordChatSystemMessage failed:", err?.message || err);
  }
  return {
    id: insertId,
    content: body,
    message: body,
    sender: "system",
    type: "system",
    source: "system",
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
  };
}

exports.getRequestingChats = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const { id: userId, role } = getCurrentUser(req);

    let rows;

    if (isAgentRole(role)) {
      // Agent: see conversations assigned to them that are still requesting (<24h)
      const [agentRows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'requesting'
           AND c.agent_id = ?
          AND c.project_id = ?
           AND ${customerHasRepliedSql}
           AND TIMESTAMPDIFF(
                 HOUR,
                 (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id),
                 NOW()
               ) < 24
         ORDER BY last_message_time DESC`,
        [userId, projectId]
      );
      rows = agentRows;
    } else {
      // Manager: see unassigned requesting conversations (<24h)
      const [managerRows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'requesting'
           AND c.agent_id IS NULL
          AND c.project_id = ?
           AND ${customerHasRepliedSql}
           AND TIMESTAMPDIFF(
                 HOUR,
                 (SELECT MAX(m.created_at) FROM message m WHERE m.conversation_id = c.id),
                 NOW()
               ) < 24
         ORDER BY last_message_time DESC`,
        [projectId]
      );
      rows = managerRows;
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/** Open Requesting queue (agent_id IS NULL) for agent pickup / manager assign */
exports.getUnassignedRequesting = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });

    const [rows] = await db.query(
      `SELECT ${conversationListFields}
       FROM conversations c
       WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'requesting'
         AND c.agent_id IS NULL
         AND ${projectScopeSql}
         AND ${customerHasRepliedSql}
         AND ${lastMessageWithin24h}
       ORDER BY last_message_time DESC`,
      [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.getActiveChats = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const { id: userId, role } = getCurrentUser(req);

    let rows;

    // Active tab = status must be 'active' only (not requesting/intervened/closed)
    if (isAgentRole(role)) {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'active'
           AND ${projectScopeSql}
           AND ${lastMessageWithin24h}
           AND c.agent_id = ?
         ORDER BY last_message_time DESC`,
        [projectId, userId]
      );
    } else {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'active'
           AND ${projectScopeSql}
           AND ${lastMessageWithin24h}
         ORDER BY last_message_time DESC`,
        [projectId]
      );
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.getHistoryChats = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const { id: userId, role } = getCurrentUser(req);

    let rows;

    if (isAgentRole(role)) {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) != 'closed'
           AND ${projectScopeSql}
           AND ${lastMessageOlderThan24h}
           AND (c.agent_id = ? OR c.agent_id IS NULL)
         ORDER BY last_message_time DESC`,
        [projectId, userId]
      );
    } else {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) != 'closed'
           AND ${projectScopeSql}
           AND ${lastMessageOlderThan24h}
         ORDER BY last_message_time DESC`,
        [projectId]
      );
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.getIntervenedChats = async (req, res) => {
  try {
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const { id: userId, role } = getCurrentUser(req);

    let rows;

    if (isAgentRole(role)) {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
           AND ${projectScopeSql}
           AND c.agent_id = ?
         ORDER BY last_message_time DESC`,
        [projectId, userId]
      );
    } else {
      [rows] = await db.query(
        `SELECT ${conversationListFields}
         FROM conversations c
         WHERE LOWER(TRIM(COALESCE(c.status,''))) = 'intervened'
           AND ${projectScopeSql}
         ORDER BY last_message_time DESC`,
        [projectId]
      );
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.getChatMessages = async (req, res) => {
  try {
    const id = req.params.id;
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ error: "Project is required" });
    const { id: userId, role } = getCurrentUser(req);

    const inProject = await assertConversationInProject(id, projectId);
    if (!inProject) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (isAgentRole(role)) {
      const [convRows] = await db.query(
        "SELECT id, agent_id, status FROM conversations WHERE id = ?",
        [id]
      );
      if (!convRows || convRows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const convAgentId = convRows[0].agent_id != null ? Number(convRows[0].agent_id) : null;
      // Allow: assigned to me, or open/unassigned (pickup + history), or already intervened by anyone for read in manager flows
      const canView =
        userId != null &&
        (convAgentId === userId || convAgentId == null);
      if (!canView) {
        return res.status(403).json({ error: "You can only view messages for conversations assigned to you" });
      }
    }

    const [convRows] = await db.query(
      "SELECT id, phone FROM conversations WHERE id = ?",
      [id]
    );
    const phone = convRows?.[0]?.phone || null;

    const [rows] = await db.query(
      "SELECT id, conversation_id, sender, message, created_at FROM message WHERE conversation_id = ? ORDER BY created_at ASC",
      [id]
    );

    const liveChatMessages = (rows || []).map((row) => {
      const sender = String(row.sender || "").toLowerCase();
      const isSystem = sender === "system";
      return {
        id: `live_${row.id}`,
        content: row.message,
        message: row.message,
        sender: row.sender,
        type: isSystem
          ? "system"
          : sender === "agent"
            ? "outgoing"
            : sender === "customer"
              ? "incoming"
              : row.sender,
        messageType: isSystem ? "system" : "text",
        sentAt: row.created_at,
        createdAt: row.created_at,
        source: isSystem ? "system" : "live_chat",
        conversationId: row.conversation_id,
      };
    });

    let inboxMessages = [];
    if (phone) {
      const variants = phoneVariantsForLookup(phone);
      const contact = await Contact.findOne({
        where: {
          phone: { [Op.in]: variants },
          projectId,
        },
      });
      if (contact) {
        const inboxRows = await InboxMessage.findAll({
          where: { contactId: contact.id, projectId },
          order: [['timestamp', 'ASC']],
        });

        const templateNamesNeeded = new Set();
        inboxRows.forEach((im) => {
          const plain = im.get ? im.get({ plain: true }) : im;
          const rowBody = String(plain.message || '').trim();
          const name = plain.templateName || extractTemplateNameFromBody(rowBody);
          if (name && (plain.isTemplateSend || isTemplateMarkerContent(rowBody))) {
            templateNamesNeeded.add(name);
          }
        });

        let templateByName = new Map();
        if (templateNamesNeeded.size > 0) {
          const ownerId = await Project.getProjectOwnerId(projectId);
          const userIds = [...new Set([Number(userId), Number(ownerId)].filter((n) => Number.isInteger(n) && n > 0))];
          const templateRows = await Template.findAll({
            where: { projectId, userId: { [Op.in]: userIds } },
            limit: 500,
          });
          templateByName = await buildTemplateCatalogMap(templateRows, { userId, projectId });
        }

        inboxMessages = await Promise.all(
          inboxRows.map((row) =>
            enrichInboxMessageForClient(row, { projectId, userId, templateByName })
          )
        );
      }
    }

    const filteredLiveChat = liveChatMessages.filter(
      (live) =>
        !inboxMessages.some(
          (inbox) => messageHasTemplateCard(inbox) && messagesMatchForDedupe(live, inbox)
        )
    );

    const merged = dedupeInboxMessages([...inboxMessages, ...filteredLiveChat]);
    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.acceptChat = async (req, res) => {
  try {
    const id = req.params.id;
    const projectId = getProjectIdFromReq(req);
    const { id: agentId } = getCurrentUser(req);

    if (!agentId) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: missing authenticated agent",
      });
    }
    if (!projectId) {
      return res.status(400).json({ success: false, error: "Project is required" });
    }

    const inProject = await assertConversationInProject(id, projectId);
    if (!inProject) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const [convRows] = await db.query(
      "SELECT id, agent_id, status FROM conversations WHERE id = ?",
      [id]
    );
    if (!convRows || convRows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const conv = convRows[0];
    const status = String(conv.status || "").toLowerCase();
    const assignedId = conv.agent_id != null ? Number(conv.agent_id) : null;

    if (status !== "requesting") {
      return res.status(400).json({
        success: false,
        error: "Only requesting chats can be accepted",
      });
    }
    if (assignedId != null && assignedId !== Number(agentId)) {
      return res.status(403).json({
        success: false,
        error: "This chat is assigned to another agent",
      });
    }

    await db.query(
      "UPDATE conversations SET status='active', agent_id=? WHERE id=?",
      [agentId, id]
    );

    res.json({ success: true, message: "Chat accepted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.interveneChat = async (req, res) => {
  try {
    const id = req.params.id;
    const { id: agentId } = getCurrentUser(req);
    if (agentId == null) {
      return res.status(401).json({ error: "Unauthorized: missing authenticated agent" });
    }
    const u = req.user || {};
    const agentName = (u.name || u.email || u.dataValues?.name || u.dataValues?.email) || "Agent";

    const [convRows] = await db.query(
      "SELECT id, phone FROM conversations WHERE id = ?",
      [id]
    );
    const phone = convRows && convRows[0] ? convRows[0].phone : null;

    // Set status to intervened AND assign to this agent so only they see it (other agents won't)
    await db.query(
      "UPDATE conversations SET status='intervened', agent_id=? WHERE id=?",
      [agentId, id]
    );

    try {
      socketService.emitToManager("intervention", {
        agentName,
        conversationId: parseInt(id, 10),
        phone,
        dateTime: new Date().toISOString(),
      });
    } catch (e) {
      console.error("Socket emit intervention error:", e);
    }

    res.json({ message: "Human intervention started" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Intervene by phone (for admin/manager from inbox - find conversation by phone and set status to intervened)
exports.interveneByPhone = async (req, res) => {
  try {
    const phone = (req.body?.phone || req.query?.phone || "").toString().trim();
    const bodyAgentId = req.body?.agentId != null ? Number(req.body.agentId) : null;
    const requesterId = req.user?.id != null ? Number(req.user.id) : null;
    if (!phone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    const digits = phone.replace(/\D/g, "");
    const noPlus = phone.replace(/^\+/, "");
    const intervenePhoneVariants = new Set(
      [
        ...phoneVariants(phone),
        digits || null,
        noPlus || null,
        digits && digits.length === 10 ? `91${digits}` : null,
        digits && digits.length === 10 ? `+91${digits}` : null,
        digits && digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : null,
      ].filter(Boolean)
    );
    const list = intervenePhoneVariants.size > 0 ? [...intervenePhoneVariants] : [phone];
    const placeholders = list.map(() => "?").join(",");
    const projectId = getProjectIdFromReq(req);

    let rows;
    if (projectId) {
      const [r] = await db.query(
        `SELECT id, agent_id FROM conversations
         WHERE status != 'closed'
           AND phone IN (${placeholders})
           AND project_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [...list, projectId]
      );
      rows = r;
    } else {
      const [r] = await db.query(
        `SELECT id, agent_id FROM conversations
         WHERE status != 'closed'
           AND phone IN (${placeholders})
         ORDER BY id DESC
         LIMIT 1`,
        list
      );
      rows = r;
    }

    let id;
    let currentAgentId;
    if (rows && rows.length > 0) {
      id = rows[0].id;
      currentAgentId = rows[0].agent_id != null ? Number(rows[0].agent_id) : null;
    } else {
      const pid = projectId || (await resolveDefaultProjectId());
      const [insertRes] = await db.query(
        "INSERT INTO conversations (phone, customer_name, last_message, status, project_id) VALUES (?, ?, '', 'requesting', ?)",
        [phone, phone, pid]
      );
      id = insertRes.insertId;
      currentAgentId = null;
    }

    // Priority:
    // 1) explicitly selected agent from UI
    // 2) already assigned agent on conversation
    // 3) authenticated requester (fallback)
    const finalAgentId = bodyAgentId || currentAgentId || requesterId || null;

    if (finalAgentId != null) {
      await db.query("UPDATE conversations SET status='intervened', agent_id=? WHERE id=?", [finalAgentId, id]);
    } else {
      await db.query("UPDATE conversations SET status='intervened' WHERE id=?", [id]);
    }
    res.json({ success: true, message: "Human intervention started" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    console.log("Chat sendMessage body:", req.body);

    const body = req.body || {};
    const { conversation_id, message } = body;
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ success: false, error: "Project is required" });

    if (!conversation_id || !message) {
      return res.status(400).json({
        success: false,
        error: "conversation_id and message are required",
      });
    }

    const { id: userId, role } = getCurrentUser(req);

    const inProject = await assertConversationInProject(conversation_id, projectId);
    if (!inProject) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const [convRows] = await db.query(
      "SELECT id, agent_id, status, phone FROM conversations WHERE id = ?",
      [conversation_id]
    );
    if (!convRows || convRows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const convAgentId = convRows[0].agent_id != null ? Number(convRows[0].agent_id) : null;
    const phone = convRows[0].phone;
    const convStatus = String(convRows[0].status || "").toLowerCase();

    if (isAgentRole(role)) {
      if (userId == null) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      if (convAgentId != null && convAgentId !== userId) {
        // After human intervention, allow sending even if agent_id is inconsistent.
        if (convStatus !== "intervened") {
          return res.status(403).json({
            success: false,
            error: "You can only send messages in conversations assigned to you",
          });
        }
      }
      if (convAgentId == null) {
        await db.query(
          "UPDATE conversations SET agent_id = ?, status = CASE WHEN LOWER(TRIM(COALESCE(status,''))) = 'requesting' THEN 'active' ELSE status END WHERE id = ?",
          [userId, conversation_id]
        );
      }
    }

    // Send actual text to WhatsApp (system events are stored in-chat only).
    const isSystemMessage = String(message || "").trim().startsWith("__SYSTEM__:");
    const storedMessage = isSystemMessage
      ? String(message).trim().slice("__SYSTEM__:".length)
      : message;
    const messageSender = isSystemMessage ? "system" : "agent";

    let liveChatTextSendSucceeded = false;
    let textSendError = null;
    try {
      if (phone && storedMessage && !isSystemMessage) {
        const contact = await Contact.findOne({ where: { phone, projectId } });
        const isOptedIn = !!(
          contact &&
          contact.status !== 'unsubscribed' &&
          contact.whatsappOptInAt
        );
        const billingAccountId =
          contact && contact.userId != null ? contact.userId : userId;

        let billing = { allowed: true, wasNew: false };
        let billingAllowed = true;
        try {
          billing = await upsertConversationWithQuota(billingAccountId, phone);
          billingAllowed = !!billing.allowed;
        } catch (billingErr) {
          console.error('Conversation billing check failed (chatController.sendMessage):', billingErr?.message || billingErr);
        }

        if (isOptedIn && billingAllowed) {
          const wcc = await requireWccForOutgoing(projectId, billing, {
            isTemplate: false,
            customerPhone: phone,
          });
          if (!wcc.ok) {
            textSendError = `Insufficient WhatsApp Conversation Credits: need ${wcc.charge}, have ${wcc.balance}`;
            console.log('❌ Blocked chat sendText (insufficient WCC):', phone);
          } else {
            const sendResult = await sendText(phone, storedMessage, null, userId, projectId);
            const wamid = sendResult?.wamid || sendResult?.messageId || null;
            if (!wamid) {
              textSendError = 'WhatsApp API did not return a message id';
            } else {
              liveChatTextSendSucceeded = true;
              await debitWccAfterSuccessfulMetaSend(projectId, wcc.ownerUserId, billing, {
                isTemplate: false,
                customerPhone: phone,
              });
            }
          }
        } else if (!isOptedIn) {
          textSendError = 'Blocked (opt-out / not opted-in)';
          console.log('❌ Blocked chat sendText (opt-out / not opted-in):', phone);
        } else {
          textSendError = 'Blocked (conversation limit reached)';
          console.log('❌ Blocked chat sendText (conversation limit reached):', phone);
        }
      }
    } catch (waErr) {
      textSendError = waErr?.message || String(waErr);
      console.error("WhatsApp sendText failed (chatController.sendMessage):", textSendError);
    }

    if (textSendError && !isSystemMessage) {
      return res.status(liveChatTextSendSucceeded ? 200 : 502).json({
        success: false,
        error: textSendError,
        message: textSendError,
      });
    }

    const [insertResult] = await db.query(
      "INSERT INTO message (conversation_id, sender, message) VALUES (?, ?, ?)",
      [conversation_id, messageSender, storedMessage]
    );
    await db.query(
      "UPDATE conversations SET last_message = ? WHERE id = ?",
      [storedMessage, conversation_id]
    );

    if (!isSystemMessage) {
      await recordOutboundInboxMessage(phone, storedMessage, {
        status: liveChatTextSendSucceeded ? 'sent' : 'failed',
        projectId,
      });
    }

    const [messageRows] = await db.query(
      "SELECT id, conversation_id, sender, message, created_at FROM message WHERE conversation_id = ? ORDER BY created_at ASC",
      [conversation_id]
    );

    return res.json({
      success: isSystemMessage || liveChatTextSendSucceeded,
      message: liveChatTextSendSucceeded || isSystemMessage ? "Agent message sent" : "Message send failed",
      messages: messageRows || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Send approved template message from Live Chat/Intervene
// Expected body: { conversation_id, templateName, templateLanguage='en_US', templateParams=[], displayText }
exports.sendTemplateMessage = async (req, res) => {
  try {
    const body = req.body || {};
    const {
      conversation_id,
      templateName,
      templateLanguage = "en_US",
      templateParams = [],
      displayText,
    } = body;
    const projectId = getProjectIdFromReq(req);
    if (!projectId) return res.status(400).json({ success: false, error: "Project is required" });

    if (!conversation_id || !templateName) {
      return res.status(400).json({
        success: false,
        error: "conversation_id and templateName are required",
      });
    }

    const { id: userId, role } = getCurrentUser(req);

    const inProject = await assertConversationInProject(conversation_id, projectId);
    if (!inProject) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const [convRows] = await db.query(
      "SELECT id, agent_id, status, phone FROM conversations WHERE id = ?",
      [conversation_id]
    );

    if (!convRows || convRows.length === 0) {
      return res.status(404).json({ success: false, error: "Conversation not found" });
    }

    const convAgentId = convRows[0].agent_id != null ? Number(convRows[0].agent_id) : null;
    const phone = convRows[0].phone;
    const convStatus = String(convRows[0].status || "").toLowerCase();

    if (isAgentRole(role)) {
      if (userId == null) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
      if (convAgentId != null && convAgentId !== userId) {
        if (convStatus !== "intervened") {
          return res.status(403).json({
            success: false,
            error: "You can only send messages in conversations assigned to you",
          });
        }
      }
      if (convAgentId == null) {
        await db.query(
          "UPDATE conversations SET agent_id = ?, status = CASE WHEN LOWER(TRIM(COALESCE(status,''))) = 'requesting' THEN 'active' ELSE status END WHERE id = ?",
          [userId, conversation_id]
        );
      }
    }

    const textToStore = displayText || templateName;
    const paramsArray = normalizeTemplateParams(templateParams);

    let clientPreview = null;
    let resolvedBody = textToStore;
    try {
      const templateRecord = await loadTemplateForProject({ templateName, userId, projectId });
      let templateContent = templateRecord?.content || textToStore;
      try {
        const components = await resolveTemplateComponentsForSend(templateRecord, {
          userId,
          projectId,
          templateName,
        });
        const bodyComponent = (components || []).find(
          (c) => String(c?.type || '').toUpperCase() === 'BODY'
        );
        if (bodyComponent?.text) templateContent = bodyComponent.text;
      } catch (_) {}
      resolvedBody = applyTemplateParamsToBody(templateContent, paramsArray) || textToStore;
      clientPreview = buildClientTemplatePreview(templateRecord, templateContent, {
        templateName,
        templateParams: paramsArray,
        body: resolvedBody,
      });
    } catch (previewErr) {
      console.warn('chat sendTemplate preview build:', previewErr?.message || previewErr);
    }

    let liveChatTemplateSendSucceeded = false;
    let waMessageId = null;
    let templateSendError = null;
    // Send approved template via WhatsApp template API
    try {
      if (phone) {
        const contact = await Contact.findOne({ where: { phone, projectId } });
        const isOptedIn = !!(
          contact &&
          contact.status !== 'unsubscribed' &&
          contact.whatsappOptInAt
        );
        const billingAccountId =
          contact && contact.userId != null ? contact.userId : userId;

        let billing = { allowed: true, wasNew: false };
        let billingAllowed = true;
        try {
          billing = await upsertConversationWithQuota(billingAccountId, phone);
          billingAllowed = !!billing.allowed;
        } catch (billingErr) {
          console.error('Conversation billing check failed (chatController.sendTemplateMessage):', billingErr?.message || billingErr);
        }

        if (isOptedIn && billingAllowed) {
          const wcc = await requireWccForOutgoing(projectId, billing, {
            isTemplate: true,
            customerPhone: phone,
          });
          if (!wcc.ok) {
            templateSendError = `Insufficient WhatsApp Conversation Credits: need ${wcc.charge}, have ${wcc.balance}`;
            console.log('❌ Blocked chat sendTemplate (insufficient WCC):', phone);
          } else {
            const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
            const templatePayload = {
              messaging_product: 'whatsapp',
              to: normalizeWhatsAppRecipient(phone),
              type: 'template',
              template: {
                name: String(templateName || '').trim(),
                language: { code: String(templateLanguage || 'en_US').trim() || 'en_US' },
              },
            };
            if (paramsArray.length) {
              templatePayload.template.components = [
                {
                  type: 'BODY',
                  parameters: paramsArray.map((param) => ({
                    type: 'text',
                    text: typeof param === 'string' ? param : String(param),
                  })),
                },
              ];
            }
            const sent = await postWhatsAppTemplateMessage(waCandidates, templatePayload, {
              userId,
              projectId,
            });
            waMessageId = sent.response?.data?.messages?.[0]?.id || null;
            if (!waMessageId) {
              templateSendError = 'WhatsApp API did not return a message id';
            } else {
              liveChatTemplateSendSucceeded = true;
              await debitWccAfterSuccessfulMetaSend(projectId, wcc.ownerUserId, billing, {
                isTemplate: true,
                customerPhone: phone,
              });
            }
          }
        } else if (!isOptedIn) {
          templateSendError = 'Blocked (opt-out / not opted-in)';
          console.log('❌ Blocked chat sendTemplate (opt-out / not opted-in):', phone);
        } else {
          templateSendError = 'Blocked (conversation limit reached)';
          console.log('❌ Blocked chat sendTemplate (conversation limit reached):', phone);
        }
      }
    } catch (waErr) {
      templateSendError = waErr?.message || String(waErr);
      console.error("WhatsApp sendTemplate failed (chatController.sendTemplateMessage):", templateSendError);
    }

    if (templateSendError) {
      return res.status(liveChatTemplateSendSucceeded ? 200 : 502).json({
        success: false,
        error: templateSendError,
        message: templateSendError,
      });
    }

    await db.query(
      "INSERT INTO message (conversation_id, sender, message) VALUES (?, 'agent', ?)",
      [conversation_id, resolvedBody || textToStore]
    );
    await db.query("UPDATE conversations SET last_message = ? WHERE id = ?", [resolvedBody || textToStore, conversation_id]);

    await recordOutboundInboxMessage(phone, resolvedBody || textToStore, {
      status: liveChatTemplateSendSucceeded ? 'sent' : 'failed',
      projectId,
      isTemplateSend: liveChatTemplateSendSucceeded,
      templateName,
      templateSnapshot: clientPreview,
      waMessageId,
    });

    const [messageRows] = await db.query(
      "SELECT id, conversation_id, sender, message, created_at FROM message WHERE conversation_id = ? ORDER BY created_at ASC",
      [conversation_id]
    );

    return res.json({
      success: liveChatTemplateSendSucceeded,
      message: liveChatTemplateSendSucceeded ? "Agent template message sent" : "Template send failed",
      waMessageId,
      messages: messageRows || [],
      templatePreview: clientPreview,
      templateName,
      isTemplate: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

exports.closeChat = async (req, res) => {
  try {
    const id = req.params.id;
    const { id: userId, role } = getCurrentUser(req);

    const dispositionRaw = normalizeDisposition(
      req.body?.disposition || req.body?.dispositionType || req.query?.disposition || ''
    );
    if (!dispositionRaw || !ALLOWED_DISPOSITIONS.has(dispositionRaw)) {
      return res.status(400).json({
        error: 'Disposition is required. Select a disposition before resolving the lead.',
      });
    }
    const dispositionLabel = getDispositionLabel(dispositionRaw);

    const [convRows] = await db.query(
      "SELECT id, agent_id FROM conversations WHERE id = ?",
      [id]
    );
    if (!convRows || convRows.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (isAgentRole(role)) {
      const convAgentId = convRows[0].agent_id != null ? Number(convRows[0].agent_id) : null;
      if (userId == null || convAgentId !== userId) {
        return res.status(403).json({ error: "You can only close conversations assigned to you" });
      }
    }

    try {
      const [cols] = await db.query(`SHOW COLUMNS FROM conversations LIKE 'disposition'`);
      if (!Array.isArray(cols) || cols.length === 0) {
        await db.query(
          `ALTER TABLE conversations ADD COLUMN disposition VARCHAR(64) NULL`
        );
      }
      const [atCols] = await db.query(
        `SHOW COLUMNS FROM conversations LIKE 'disposition_updated_at'`
      );
      if (!Array.isArray(atCols) || atCols.length === 0) {
        await db.query(
          `ALTER TABLE conversations ADD COLUMN disposition_updated_at DATETIME NULL`
        );
      }
    } catch (e) {
      console.error('Could not ensure conversations.disposition columns:', e?.message || e);
    }

    const actorName = await fetchUserDisplayName(userId);
    const systemMessage = await recordChatSystemMessage(
      id,
      `Chat resolved by ${actorName} · Disposition: ${dispositionLabel}`
    );

    await db.query(
      "UPDATE conversations SET status='closed', disposition=?, disposition_updated_at=NOW() WHERE id=?",
      [dispositionRaw, id]
    );

    res.json({
      success: true,
      message: "Chat closed",
      disposition: dispositionRaw,
      dispositionLabel,
      systemMessage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 3️⃣ MANAGER: assign chat to an agent explicitly
// Expects body: { conversationId, agentId }
exports.assignChat = async (req, res) => {
  try {
    const body = req.body || {};
    const conversationId = body.conversationId;
    const agentId = body.agentId;

    if (!conversationId || !agentId) {
      return res.status(400).json({
        success: false,
        message: "conversationId and agentId are required",
      });
    }

    // IMPORTANT: keep status='requesting' on assignment.
    // This way:
    // - Manager sees it first (unassigned requesting)
    // - After assignment it moves to agent's Requesting tab
    // - Only when agent clicks "Accept", status becomes 'active'
    await db.query(
      "UPDATE conversations SET agent_id = ?, status = 'requesting' WHERE id = ?",
      [agentId, conversationId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Agent/Admin takeover endpoint:
// Expects body: { conversationId, agentId }
// Sets explicit ownership + intervened status.
exports.assignAgentTakeover = async (req, res) => {
  try {
    const body = req.body || {};
    const conversationId = body.conversationId;
    const bodyAgentId = body.agentId;
    const requesterId = req.user?.id;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "conversationId is required",
      });
    }

    const finalAgentId = Number(bodyAgentId || requesterId);
    if (!finalAgentId || Number.isNaN(finalAgentId)) {
      return res.status(400).json({
        success: false,
        message: "agentId is required",
      });
    }

    const [convRows] = await db.query(
      "SELECT id, agent_id FROM conversations WHERE id = ?",
      [conversationId]
    );
    if (!convRows || convRows.length === 0) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const previousAgentId =
      convRows[0].agent_id != null ? Number(convRows[0].agent_id) : null;
    const requesterName = await fetchUserDisplayName(requesterId);
    const targetName = await fetchUserDisplayName(finalAgentId);
    const previousName =
      previousAgentId && previousAgentId !== finalAgentId
        ? await fetchUserDisplayName(previousAgentId)
        : null;

    await db.query(
      "UPDATE conversations SET agent_id = ?, status = 'intervened' WHERE id = ?",
      [finalAgentId, conversationId]
    );

    let systemText;
    if (Number(requesterId) === finalAgentId && previousName) {
      systemText = `Chat taken over by ${requesterName} from ${previousName}`;
    } else if (previousName && previousName !== targetName) {
      systemText = `Chat transferred from ${previousName} to ${targetName} by ${requesterName}`;
    } else {
      systemText = `Chat transferred to ${targetName} by ${requesterName}`;
    }

    const systemMessage = await recordChatSystemMessage(conversationId, systemText);

    res.json({
      success: true,
      message: "Assigned",
      systemMessage,
      fromAgent: previousName || null,
      toAgent: targetName,
      byAgent: requesterName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
