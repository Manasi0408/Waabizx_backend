const { Op } = require('sequelize');
const { Contact, InboxMessage } = require('../models');

function phoneVariants(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return [];
  const noPlus = raw.replace(/^\+/, '');
  return [...new Set([raw, noPlus, `+${noPlus}`].filter(Boolean))];
}

/**
 * Record an outbound send for dashboard "messages sent today" and inbox parity.
 * Uses contact.userId (account owner) so owner dashboards include agent sends.
 */
async function recordOutboundInboxMessage(phone, messageBody, opts = {}) {
  const {
    type = 'text',
    status = 'sent',
    waMessageId = null,
    projectId: scopedProjectId = null,
    isTemplateSend = false,
    templateName = null,
    templateSnapshot = null,
  } = opts;
  const variants = phoneVariants(phone);
  if (variants.length === 0) return null;

  try {
    const contactWhere = { phone: { [Op.in]: variants } };
    if (scopedProjectId != null && Number(scopedProjectId) > 0) {
      contactWhere.projectId = Number(scopedProjectId);
    }
    const contact = await Contact.findOne({
      where: contactWhere,
    });
    if (!contact || contact.userId == null) return null;

    const snapshotJson =
      templateSnapshot == null
        ? null
        : typeof templateSnapshot === 'string'
          ? templateSnapshot
          : JSON.stringify(templateSnapshot);

    return await InboxMessage.create({
      contactId: contact.id,
      userId: contact.userId,
      projectId: contact.projectId != null ? contact.projectId : scopedProjectId,
      direction: 'outgoing',
      message: String(messageBody != null ? messageBody : '').slice(0, 65000) || '(no text)',
      type,
      status,
      isTemplateSend: !!isTemplateSend,
      templateName: templateName || null,
      templateSnapshot: snapshotJson,
      waMessageId,
      timestamp: new Date(),
    });
  } catch (e) {
    console.error('recordOutboundInboxMessage:', e?.message || e);
    return null;
  }
}

module.exports = { recordOutboundInboxMessage, phoneVariants };
