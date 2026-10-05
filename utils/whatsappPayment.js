const WhatsAppAccount = require('../models/WhatsAppAccount');
const { ensureWhatsAppAccountPaymentColumns } = require('./ensureWhatsAppAccountSchema');

async function findScopedWhatsAppAccount(clientId, projectId = null) {
  const cid = Number(clientId);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  await ensureWhatsAppAccountPaymentColumns();
  const pid = projectId != null ? Number(projectId) : null;
  if (Number.isInteger(pid) && pid > 0) {
    return WhatsAppAccount.findOne({
      where: { client_id: cid, projectId: pid },
      order: [['id', 'DESC']],
    });
  }
  return WhatsAppAccount.findOne({
    where: { client_id: cid },
    order: [['id', 'DESC']],
  });
}

async function getWhatsAppPaymentState(clientId, projectId = null) {
  const account = await findScopedWhatsAppAccount(clientId, projectId);
  if (!account || !String(account.waba_id || '').trim()) {
    return {
      hasWhatsAppAccount: false,
      metaLinked: false,
      paymentRequired: false,
      readyToSendMessages: false,
      redirectUrl: null,
    };
  }

  const wabaId = String(account.waba_id || '').trim();
  const token = String(account.access_token || '').trim();
  const metaLinked = Boolean(wabaId && account.phone_number_id && token);

  return {
    hasWhatsAppAccount: true,
    metaLinked,
    paymentRequired: false,
    readyToSendMessages: metaLinked,
    redirectUrl: null,
    businessId: account.business_id || null,
    wabaId: account.waba_id || null,
    phoneNumberId: account.phone_number_id || null,
    displayPhone: account.display_phone || null,
    projectId: account.projectId != null ? Number(account.projectId) : null,
  };
}

async function assertWhatsAppMessagingActive(clientId, projectId) {
  const state = await getWhatsAppPaymentState(clientId, projectId);
  if (!state.hasWhatsAppAccount || state.readyToSendMessages) {
    return { ok: true, ...state };
  }

  return {
    ok: false,
    message:
      'WhatsApp is not fully connected yet. Open Connect WhatsApp and complete Meta Embedded Signup.',
    redirectUrl: '/connect-whatsapp',
    ...state,
  };
}

module.exports = {
  findScopedWhatsAppAccount,
  getWhatsAppPaymentState,
  assertWhatsAppMessagingActive,
};
