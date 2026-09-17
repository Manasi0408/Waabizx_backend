const db = require("../config/db");
const { sendText } = require("../services/whatsappService");
const { Contact } = require("../models");
const Project = require("../models/Project");
const { upsertConversationWithQuota } = require("../services/conversationBillingService");
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require("../services/wccMetaChargeService");
const { recordOutboundInboxMessage } = require("../services/outboundInboxService");
const { getProjectId } = require("../utils/projectScope");

const chatListFields = `id,phone,customer_name,last_message,last_message_time,unread_count,status`;

exports.getActiveChats = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ${chatListFields}
      FROM agent_conversations
      WHERE LOWER(COALESCE(status,'')) = 'active'
      ORDER BY last_message_time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
};

exports.getRequestingChats = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ${chatListFields}
      FROM agent_conversations
      WHERE LOWER(COALESCE(status,'')) = 'requesting'
      ORDER BY last_message_time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
};

exports.getIntervenedChats = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ${chatListFields}
      FROM agent_conversations
      WHERE LOWER(COALESCE(status,'')) = 'intervened'
      ORDER BY last_message_time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
};

exports.getChatMessages = async (req, res) => {
  try {
    const conversationId = req.params.id;
    const [rows] = await db.query(
      `SELECT sender,message,message_type,created_at
      FROM agent_messages
      WHERE conversation_id=?
      ORDER BY created_at ASC`,
      [conversationId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(err);
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const body = req.body || {};
    const { conversation_id, phone, message } = body;
    const projectId = getProjectId(req);

    if (conversation_id == null || !phone || message == null) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: conversation_id, phone, message",
      });
    }

    // Conversation billing/quota (24h window) + WCC: must run for every send so `wasNew` is correct.
    let billing = { allowed: true, wasNew: false };
    let billingAllowed = true;
    try {
      const contactWhere = { phone };
      if (projectId) contactWhere.projectId = projectId;
      const contact = await Contact.findOne({ where: contactWhere });
      let billingAccountId = req.user?.id;
      if (contact?.userId != null) {
        billingAccountId = contact.userId;
      } else if (projectId) {
        const ownerId = await Project.getProjectOwnerId(projectId);
        if (ownerId) billingAccountId = ownerId;
      }
      billing = await upsertConversationWithQuota(billingAccountId, phone);
      billingAllowed = !!billing.allowed;
    } catch (billingErr) {
      console.error('Conversation billing check failed (agentChatController.sendMessage):', billingErr?.message || billingErr);
    }

    if (billingAllowed) {
      if (projectId) {
        const wcc = await requireWccForOutgoing(projectId, billing, {
          isTemplate: false,
          customerPhone: phone,
        });
        if (!wcc.ok) {
          console.log('❌ Blocked agent chat sendText (insufficient WCC):', phone);
        } else {
          await sendText(phone, message);
          await debitWccAfterSuccessfulMetaSend(projectId, wcc.ownerUserId, billing, {
            isTemplate: false,
            customerPhone: phone,
          });
        }
      } else {
        await sendText(phone, message);
      }
    } else {
      console.log('❌ Blocked agent chat sendText (conversation limit reached):', phone);
    }

    await db.query(
      `INSERT INTO agent_messages
      (conversation_id,sender,message,message_type,created_at)
      VALUES(?,?,?,?,NOW())`,
      [conversation_id, "agent", message, "text"]
    );

    await db.query(
      `UPDATE agent_conversations
      SET last_message=?,last_message_time=NOW(),unread_count=0
      WHERE id=?`,
      [message, conversation_id]
    );

    await recordOutboundInboxMessage(phone, message, { status: 'sent', projectId });

    res.json({ success: true });
  } catch (err) {
    console.log(err);
    res.status(500).json(err);
  }
};
