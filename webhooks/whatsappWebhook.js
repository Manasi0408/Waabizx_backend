const db = require("../config/db");
const socketService = require("../services/socketService");
const { Contact, User } = require("../models");
const { sendText } = require("../services/whatsappService");
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('../services/wccMetaChargeService');
const { extractInboundText, extractInboundReplyCandidates, getInboundMessageKind } = require('../utils/inboundMessageParser');
const { handleInboundFlowMessage } = require('../services/flowWhatsAppService');
const { claimInboundWebhookMessage } = require('../utils/webhookInboundDedup');
const {
  persistInboundCustomerMessage,
  resolveInboundProjectId,
} = require('../services/inboundInboxPersistService');

// Defaults shown in the Opt-in Management UI
const OPT_IN_MESSAGE =
  'Thanks! You have been opted in for future marketing messages. You will now receive updates and notifications related to this project.';
const OPT_OUT_MESSAGE =
  'You have been opted out of your future marketing messages. If you would like to receive messages again, reply APPLY above US/APPLY.';

// AiSensy-style: use conversations + message table.
// New customer message → REQUESTING; existing → keep current status (requesting/active/intervened).
// Also route inbounds to the correct agent_* or manager room based on conversations.agent_id.
exports.receiveMessage = async (req, res) => {
  try {
    console.log("Incoming WhatsApp webhook payload (agent webhook):", JSON.stringify(req.body, null, 2));

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const phone = message.from;
    const text = extractInboundText(message) || message.text?.body || "";
    const replyCandidates = extractInboundReplyCandidates(message);
    const inboundKind = getInboundMessageKind(message);
    const valueEntry = req.body.entry?.[0]?.changes?.[0]?.value || {};
    const timestamp = message.timestamp ? new Date(message.timestamp * 1000) : new Date();
    const projectId = await resolveInboundProjectId(req.body, valueEntry, phone);

    if (!claimInboundWebhookMessage(message?.id, phone, text)) {
      console.log('⏭️ Duplicate inbound webhook skipped (agent webhook):', {
        messageId: message?.id,
        phone,
      });
      await persistInboundCustomerMessage({
        messageObj: message,
        phone,
        text,
        projectId,
        timestamp,
        waMessageId: message?.id,
      }).catch((err) => {
        console.error('Inbound persist on duplicate webhook failed (agent):', err?.message || err);
      });
      return res.sendStatus(200);
    }

    // Consent handling for the Contacts table:
    // - First message for a new contact => opt-in (unless STOP/UNSUBSCRIBE/CANCEL)
    // - STOP/UNSUBSCRIBE/CANCEL => opt-out
    const normalizedText = (text || "").toString().trim().toUpperCase();
    const isOptOut =
      normalizedText === "STOP" ||
      normalizedText === "UNSUBSCRIBE" ||
      normalizedText === "CANCEL";
    const isOptInKeyword =
      normalizedText === "START" || normalizedText === "YES" || normalizedText === "HI";

    // Update/ensure consent state in DB so admins see it in Contacts table
    let contact = null;
    try {
      contact = await Contact.findOne({ where: { phone } });
      const wasNewContact = !contact;
      const oldOptedOut = contact
        ? contact.status === 'unsubscribed' || !contact.whatsappOptInAt
        : false;

      if (!contact) {
        const firstUser = await User.findOne({
          where: { status: "active" },
          order: [["id", "ASC"]],
        });

        if (firstUser) {
          contact = await Contact.create({
            userId: firstUser.id,
            projectId: projectId || null,
            phone,
            name: phone,
            status: isOptOut ? "unsubscribed" : "active",
            whatsappOptInAt: isOptOut ? null : new Date(),
          });
        }
      } else {
        if (isOptOut) {
          await contact.update({ status: "unsubscribed", whatsappOptInAt: null });
        } else if (isOptInKeyword && !contact.whatsappOptInAt) {
          await contact.update({ status: "active", whatsappOptInAt: new Date() });
        } else if (wasNewContact && contact.status !== "unsubscribed" && !contact.whatsappOptInAt) {
          // Safety net (shouldn't happen often because create sets the timestamp)
          await contact.update({ status: "active", whatsappOptInAt: new Date() });
        }
      }

      if (contact) {
        await contact.update({ lastContacted: new Date() });
      }

      // Auto-reply on first consent change
      let billing = { allowed: true, wasNew: false };
      let billingAllowed = true;
      try {
        if (contact) {
          billing = await upsertConversationWithQuota(contact.userId, phone);
          billingAllowed = !!billing.allowed;
        }
      } catch (billingErr) {
        console.error('Conversation billing check failed (whatsappWebhook):', billingErr?.message || billingErr);
      }

      try {
        let flowHandled = false;
        let flowResult = null;
        if (contact?.userId) {
          try {
            flowResult = await handleInboundFlowMessage({
              contact,
              userId: contact.userId,
              projectId: contact.projectId || null,
              inboundText: text,
              replyCandidates,
              inboundPhone: phone,
              inboundKind,
            });
            flowHandled = Boolean(flowResult?.handled);
          } catch (flowErr) {
            console.error('Flow handler error (agent webhook):', flowErr?.message || flowErr);
          }
        }

        const suppressConsentAutoReply =
          flowHandled ||
          flowResult?.flowId != null ||
          flowResult?.matchSource === "keyword" ||
          flowResult?.matchSource === "session" ||
          flowResult?.matchSource === "template_button";

        if (billingAllowed && !flowHandled && !suppressConsentAutoReply) {
          const autoPid = contact?.projectId != null ? Number(contact.projectId) : null;
          const sendAuto = async (replyBody) => {
            if (!autoPid) {
              await sendText(phone, replyBody);
              return;
            }
            const wcc = await requireWccForOutgoing(autoPid, billing, {
              isTemplate: false,
              customerPhone: phone,
            });
            if (!wcc.ok) {
              console.log('Auto-reply skipped (insufficient WCC) [agent webhook]');
              return;
            }
            await sendText(phone, replyBody);
            await debitWccAfterSuccessfulMetaSend(autoPid, wcc.ownerUserId, billing, {
              isTemplate: false,
              customerPhone: phone,
            });
          };
          if (isOptOut && !oldOptedOut) {
            await sendAuto(OPT_OUT_MESSAGE);
          }
        }
      } catch (e) {
        console.error('Auto reply sendText failed (agent webhook):', e?.message || e);
      }
    } catch (consentErr) {
      console.error("Consent sync to Contacts table failed:", consentErr);
    }

    const persisted = await persistInboundCustomerMessage({
      messageObj: message,
      phone,
      text,
      projectId: contact?.projectId || projectId,
      timestamp,
      waMessageId: message?.id,
      userId: contact?.userId,
    });
    const convId = persisted.conversationId;

    socketService.emitToManager("new-message", {
      conversationId: convId,
      phone,
      message: text,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      hint:
        err.code === "ER_NO_SUCH_TABLE"
          ? "Run backend/sql/chat_messages_table.sql and ensure conversations table exists."
          : undefined,
    });
  }
};
