const {
  resolveWhatsAppSendCredentialCandidates,
  postWhatsAppMessage,
  postWhatsAppTemplateMessage,
  formatMetaApiErrorMessage,
} = require('../utils/metaWhatsAppCredentials');
const { sendMessageDirectApi, getPrimaryDirectApiBase } = require('./aisensyDirectApiClient');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');

const getPhoneNumberId = () =>
  String(
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
      process.env.PHONE_NUMBER_ID ||
      process.env.WA_PHONE_NUMBER_ID ||
      process.env.Phone_Number_ID ||
      ''
  ).trim();

async function sendViaAisensyDirectApi(phoneNumberId, payload, isMarketing = false, projectId = null) {
  const body = { ...payload, phone_number_id: phoneNumberId };
  if (body.to) body.to = normalizeWhatsAppRecipient(body.to);
  const result = await sendMessageDirectApi(phoneNumberId, body, {
    base: getPrimaryDirectApiBase(),
    isMarketing,
    projectId: projectId != null ? projectId : undefined,
    localProjectId: projectId != null ? projectId : undefined,
  });
  return { status: result.status, data: result.data };
}

function okResult(data) {
  const messageId = data?.messages?.[0]?.id;
  return {
    success: true,
    messageId,
    wamid: messageId,
    response: data,
  };
}

const sendText = async (to, body, credentials = null, clientId = null, projectId = null) => {
  const phone = normalizeWhatsAppRecipient(to);
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body },
  };

  let candidates = null;
  if (Array.isArray(credentials)) {
    candidates = credentials;
  } else if (clientId != null) {
    candidates = await resolveWhatsAppSendCredentialCandidates(clientId, projectId);
  } else if (credentials?.phoneNumberId) {
    candidates = [credentials];
  }

  if (candidates?.length) {
    try {
      const sent = await postWhatsAppMessage(candidates, payload, {
        userId: clientId,
        projectId,
      });
      return okResult(sent.response?.data);
    } catch (error) {
      const msg = error.metaMessage || formatMetaApiErrorMessage(error) || error.message;
      throw new Error(msg || 'Failed to send text message via AiSensy Direct API');
    }
  }

  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured. Please add it to your .env file.');
  }

  const result = await sendViaAisensyDirectApi(phoneNumberId, payload);
  return okResult(result.data);
};

const sendTemplate = async (
  to,
  templateName,
  languageCode = 'en_US',
  parameters = [],
  credentials = null,
  options = {}
) => {
  const phone = normalizeWhatsAppRecipient(to);
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };
  if (parameters?.length) {
    payload.template.components = [
      {
        type: 'BODY',
        parameters: parameters.map((param) => ({ type: 'text', text: param })),
      },
    ];
  }

  let candidates = null;
  if (Array.isArray(credentials)) {
    candidates = credentials;
  } else if (options.userId != null || options.clientId != null) {
    candidates = await resolveWhatsAppSendCredentialCandidates(
      options.userId ?? options.clientId,
      options.projectId
    );
  } else if (credentials?.phoneNumberId) {
    candidates = [credentials];
  }

  if (candidates?.length) {
    const sent = await postWhatsAppTemplateMessage(candidates, payload, {
      userId: options.userId ?? options.clientId,
      projectId: options.projectId,
    });
    return okResult(sent.response?.data);
  }

  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured. Please add it to your .env file.');
  }

  const { resolveDirectApiIsMarketing } = require('../utils/metaWhatsAppCredentials');
  const isMarketing = await resolveDirectApiIsMarketing(payload, {
    userId: options.userId ?? options.clientId,
    projectId: options.projectId,
  });
  const result = await sendViaAisensyDirectApi(
    phoneNumberId,
    payload,
    isMarketing,
    options.projectId
  );
  return okResult(result.data);
};

module.exports = {
  sendText,
  sendTemplate,
};
