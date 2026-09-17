const {
  resolveWhatsAppSendCredentialCandidates,
  formatMetaApiErrorMessage,
} = require('../utils/metaWhatsAppCredentials');
const { sendMessageDirectApi, getPrimaryDirectApiBase } = require('./aisensyDirectApiClient');
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
  debitWccAfterSuccessfulMetaSend,
} = require('../services/wccMetaChargeService');
const { assertWhatsAppMessagingActive } = require('../utils/whatsappPayment');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');
const { normalizeDirectApiOutboundPayload } = require('../utils/directApiPayloadUtil');

function normalizePhoneNumberId(value) {
  return String(value || '').trim();
}

function normalizeRecipientPhone(payload) {
  return normalizeWhatsAppRecipient(payload?.to || payload);
}

function normalizeMetaPayload(body = {}, options = {}) {
  return normalizeDirectApiOutboundPayload(body, options);
}

function validateMetaPayload(payload) {
  if (!payload.to) {
    return 'Field "to" is required';
  }
  if (!payload.type) {
    return 'Field "type" is required';
  }
  if (payload.messaging_product && payload.messaging_product !== 'whatsapp') {
    return 'Only messaging_product "whatsapp" is supported';
  }
  return null;
}

async function resolveCredentialForPhone(phoneNumberId, clientId, projectId) {
  const targetId = normalizePhoneNumberId(phoneNumberId);
  if (!targetId) return null;

  const candidates = await resolveWhatsAppSendCredentialCandidates(clientId, projectId);
  const match = candidates.find((c) => normalizePhoneNumberId(c.phoneNumberId) === targetId);
  return match || null;
}

async function ensurePhoneReadyForSend(_creds) {
  /* AiSensy BSP — WABA linked via submit-facebook-access-token, not Graph /register */
}

async function postToAisensyDirectApi(creds, payload, isMarketing = false, projectId = null) {
  const body = { ...payload, phone_number_id: creds.phoneNumberId };
  const result = await sendMessageDirectApi(creds.phoneNumberId, body, {
    base: getPrimaryDirectApiBase(),
    isMarketing,
    localProjectId: projectId != null ? Number(projectId) : undefined,
    externalProjectId: undefined,
  });
  return { status: result.status, data: result.data };
}

function normalizeDirectApiSendResponse(data) {
  if (data?.messages?.[0]?.id) return data;
  const id =
    data?.messages?.[0]?.messageId ||
    data?.messageId ||
    data?.message_id ||
    data?.id;
  if (id) {
    return {
      messaging_product: 'whatsapp',
      contacts: data?.contacts,
      messages: [{ id: String(id) }],
    };
  }
  return data;
}

async function sendDirectApiMessage({
  phoneNumberId,
  projectId,
  clientId,
  body,
  isMarketing = false,
}) {
  const payload = normalizeMetaPayload(body, { isMarketing });
  const validationError = validateMetaPayload(payload);
  if (validationError) {
    const err = new Error(validationError);
    err.statusCode = 400;
    throw err;
  }

  const paymentState = await assertWhatsAppMessagingActive(clientId, projectId);
  if (!paymentState.ok) {
    const err = new Error(paymentState.message || 'WhatsApp is not connected');
    err.statusCode = 403;
    throw err;
  }

  const creds = await resolveCredentialForPhone(phoneNumberId, clientId, projectId);
  if (!creds) {
    const err = new Error('Phone number id is not linked to this project');
    err.statusCode = 404;
    throw err;
  }

  const isTemplate = payload.type === 'template';
  const recipientPhone = normalizeRecipientPhone(payload);

  let billing = { allowed: true, wasNew: false };
  try {
    billing = await upsertConversationWithQuota(clientId, recipientPhone);
  } catch (billingErr) {
    console.error('[direct-api] billing check:', billingErr?.message || billingErr);
  }

  if (!billing.allowed) {
    const err = new Error('Conversation limit reached');
    err.statusCode = 403;
    throw err;
  }

  const wccCheck = await requireWccForOutgoing(projectId, billing, {
    isTemplate: isTemplate || isMarketing,
    customerPhone: recipientPhone,
  });
  if (!wccCheck.ok) {
    const err = new Error(
      `Insufficient WhatsApp Conversation Credits: need ${wccCheck.charge}, have ${wccCheck.balance}`
    );
    err.statusCode = 403;
    throw err;
  }

  await ensurePhoneReadyForSend(creds);
  const response = await postToAisensyDirectApi(creds, payload, isMarketing, projectId);
  const data = normalizeDirectApiSendResponse(response.data);

  if (data?.messages?.[0]?.id && wccCheck.ownerUserId) {
    try {
      await debitWccAfterSuccessfulMetaSend(projectId, wccCheck.ownerUserId, billing, {
        isTemplate: isTemplate || isMarketing,
        customerPhone: recipientPhone,
      });
    } catch (debitErr) {
      console.error('[direct-api] WCC debit:', debitErr?.message || debitErr);
    }
  }

  return {
    status: response.status,
    data,
    creds,
  };
}

module.exports = {
  sendDirectApiMessage,
  normalizeDirectApiSendResponse,
  formatMetaApiErrorMessage,
};
