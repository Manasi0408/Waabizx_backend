const { Op } = require('sequelize');
const { Contact } = require('../models');
const { phoneVariantsForLookup } = require('../utils/phoneNormalize');

const FLOW_SESSION_KEY = '_flowSession';

function parseCustomFields(customFields) {
  let cf = customFields;
  if (typeof cf === 'string') {
    try {
      cf = JSON.parse(cf);
    } catch (_) {
      cf = {};
    }
  }
  return cf && typeof cf === 'object' && !Array.isArray(cf) ? cf : {};
}

function normalizeProjectId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sessionMatchesProject(session, projectId, contactProjectId = null) {
  if (!session || !projectId) return true;
  const expected = normalizeProjectId(projectId);
  if (!expected) return true;
  if (session.projectId) {
    return Number(session.projectId) === expected;
  }
  const contactPid = normalizeProjectId(contactProjectId);
  if (contactPid) return contactPid === expected;
  return true;
}

function readSession(customFields) {
  const cf = parseCustomFields(customFields);
  const session = cf[FLOW_SESSION_KEY];
  if (!session || typeof session !== 'object') return null;
  if (!session.flowId) return null;
  return {
    flowId: Number(session.flowId),
    currentNodeId: session.currentNodeId ? String(session.currentNodeId) : null,
    projectId: normalizeProjectId(session.projectId),
    phoneNumberId: String(session.phoneNumberId || '').trim() || null,
    updatedAt: session.updatedAt || null,
  };
}

async function getFlowSession(contact, expectedProjectId = null) {
  if (!contact) return null;
  const session = readSession(contact.customFields);
  if (!session) return null;
  if (
    expectedProjectId &&
    !sessionMatchesProject(session, expectedProjectId, contact.projectId)
  ) {
    return null;
  }
  return session;
}

async function saveFlowSession(contact, { flowId, currentNodeId, projectId, phoneNumberId }) {
  if (!contact) return null;
  const cf = { ...parseCustomFields(contact.customFields) };
  const resolvedProjectId =
    normalizeProjectId(projectId) ||
    normalizeProjectId(contact.projectId) ||
    normalizeProjectId(cf[FLOW_SESSION_KEY]?.projectId);
  const resolvedPhoneNumberId =
    String(phoneNumberId || cf[FLOW_SESSION_KEY]?.phoneNumberId || '').trim() || null;
  cf[FLOW_SESSION_KEY] = {
    flowId: Number(flowId),
    currentNodeId: currentNodeId ? String(currentNodeId) : null,
    projectId: resolvedProjectId,
    phoneNumberId: resolvedPhoneNumberId,
    updatedAt: new Date().toISOString(),
  };
  await contact.update({ customFields: cf });
  contact.customFields = cf;
  return cf[FLOW_SESSION_KEY];
}

async function clearFlowSession(contact) {
  if (!contact) return;
  const cf = { ...parseCustomFields(contact.customFields) };
  delete cf[FLOW_SESSION_KEY];
  await contact.update({ customFields: cf });
  contact.customFields = cf;
}

async function findContactWithFlowSession(phone, userId, projectId) {
  const variants = phoneVariantsForLookup(phone);
  if (!variants.length) return null;

  const where = {
    phone: { [Op.in]: variants },
    ...(userId ? { userId: Number(userId) } : {}),
  };

  const rows = await Contact.findAll({
    where,
    order: [['updatedAt', 'DESC']],
    limit: 20,
    attributes: ['id', 'phone', 'userId', 'projectId', 'customFields', 'updatedAt'],
  });

  const withSession = rows.filter((row) => readSession(row.customFields));
  if (!withSession.length) return null;

  if (projectId) {
    const expected = Number(projectId);
    const scoped = withSession.find((row) => {
      const session = readSession(row.customFields);
      if (!session) return false;
      if (Number(row.projectId) === expected) return true;
      return session.projectId && Number(session.projectId) === expected;
    });
    return scoped || null;
  }

  return withSession.sort((a, b) => {
    const aAt = new Date(a.customFields?._flowSession?.updatedAt || a.updatedAt || 0).getTime();
    const bAt = new Date(b.customFields?._flowSession?.updatedAt || b.updatedAt || 0).getTime();
    return bAt - aAt;
  })[0];
}

module.exports = {
  getFlowSession,
  saveFlowSession,
  clearFlowSession,
  readSession,
  parseCustomFields,
  findContactWithFlowSession,
};
