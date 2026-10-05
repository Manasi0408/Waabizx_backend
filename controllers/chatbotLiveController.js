const { Op } = require('sequelize');
const ChatbotLiveSession = require('../models/ChatbotLiveSession');
const ChatbotLiveMessage = require('../models/ChatbotLiveMessage');
const User = require('../models/User');
const { ensureChatbotLiveSchema } = require('../utils/ensureChatbotLiveSchema');
const { emitToRoom, emitToUser } = require('../services/socketService');

const CHATBOT_AGENTS_ROOM = 'chatbot_agents';
const LIVE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const LIVE_REQUEST_TIMEOUT_MESSAGE =
  'No agent was available within 2 minutes. You are back with the WaabizX AI assistant. You can ask for Manual help again anytime.';

async function expireStaleRequestingSessions() {
  const cutoff = new Date(Date.now() - LIVE_REQUEST_TIMEOUT_MS);
  const stale = await ChatbotLiveSession.findAll({
    where: {
      status: 'requesting',
      createdAt: { [Op.lt]: cutoff },
    },
  });

  for (const row of stale) {
    const sessionId = Number(row.id);
    const [claimed] = await ChatbotLiveSession.update(
      { status: 'closed' },
      { where: { id: sessionId, status: 'requesting' } }
    );
    if (!claimed) continue;

    await appendMessage(sessionId, {
      senderRole: 'system',
      senderUserId: null,
      body: LIVE_REQUEST_TIMEOUT_MESSAGE,
    });

    broadcastLiveEvent('chatbot-live:accepted', { sessionId, expired: true });
    emitToUser(Number(row.customerUserId), 'chatbot-live:session-ended', {
      sessionId,
      reason: 'timeout',
    });
  }
}

function normalizeRole(user) {
  return String(user?.role || '')
    .toLowerCase()
    .trim()
    .replace(/-/g, '_')
    .replace(/\s+/g, '_');
}

function broadcastLiveEvent(event, payload) {
  emitToRoom(CHATBOT_AGENTS_ROOM, event, payload);
}

function notifyLiveChatActivity(sessionRow, sessionId) {
  const sid = Number(sessionId || sessionRow?.id);
  if (!sid || !sessionRow) return;
  const payload = { sessionId: sid };
  const customerId = Number(sessionRow.customerUserId);
  const agentId = Number(sessionRow.assignedAgentId);
  if (Number.isInteger(customerId) && customerId > 0) {
    emitToUser(customerId, 'chatbot-live:activity', payload);
  }
  if (Number.isInteger(agentId) && agentId > 0) {
    emitToUser(agentId, 'chatbot-live:activity', payload);
  }
}

function isChatbotAgent(user) {
  return normalizeRole(user) === 'chatbot_agent';
}

function isCustomerRole(user) {
  const role = normalizeRole(user);
  return ['admin', 'manager', 'agent'].includes(role);
}

function resolveProjectId(req) {
  const raw =
    req.headers['x-project-id'] ??
    req.headers['x_project_id'] ??
    req.body?.projectId ??
    req.query?.projectId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function appendMessage(sessionId, { senderRole, senderUserId, body }) {
  const text = String(body || '').trim();
  if (!text) return null;
  const row = await ChatbotLiveMessage.create({
    sessionId,
    senderRole,
    senderUserId: senderUserId || null,
    body: text,
  });
  await ChatbotLiveSession.update(
    { lastMessageAt: new Date() },
    { where: { id: sessionId } }
  );
  return row;
}

function mapMessage(row) {
  const j = row?.toJSON ? row.toJSON() : row;
  return {
    id: j.id,
    sessionId: j.sessionId,
    senderRole: j.senderRole,
    senderUserId: j.senderUserId,
    body: j.body,
    createdAt: j.createdAt,
  };
}

function mapSession(row, extra = {}) {
  const j = row?.toJSON ? row.toJSON() : row;
  return {
    id: j.id,
    projectId: j.projectId,
    customerUserId: j.customerUserId,
    customerName: j.customerName,
    assignedAgentId: j.assignedAgentId,
    status: j.status,
    lastMessageAt: j.lastMessageAt,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    ...extra,
  };
}

exports.requestManualAgent = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    await expireStaleRequestingSessions();
    if (!isCustomerRole(req.user)) {
      return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const projectId = resolveProjectId(req);
    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }
    const customerUserId = Number(req.user.id);

    const existing = await ChatbotLiveSession.findOne({
      where: {
        customerUserId,
        projectId,
        status: { [Op.in]: ['requesting', 'active'] },
      },
      order: [['id', 'DESC']],
    });
    if (existing) {
      const messages = await ChatbotLiveMessage.findAll({
        where: { sessionId: existing.id },
        order: [['id', 'ASC']],
      });
      if (existing.status === 'requesting') {
        broadcastLiveEvent('chatbot-live:request', {
          session: mapSession(existing),
        });
      }
      return res.json({
        success: true,
        session: mapSession(existing),
        messages: messages.map(mapMessage),
      });
    }

    const customerName = String(req.user.name || req.user.email || 'Customer').trim();
    const session = await ChatbotLiveSession.create({
      projectId,
      customerUserId,
      customerName,
      status: 'requesting',
      lastMessageAt: new Date(),
    });
    await appendMessage(session.id, {
      senderRole: 'system',
      senderUserId: null,
      body: 'Customer requested a manual assistant. Waiting for an agent to accept.',
    });

    const messages = await ChatbotLiveMessage.findAll({
      where: { sessionId: session.id },
      order: [['id', 'ASC']],
    });

    broadcastLiveEvent('chatbot-live:request', {
      session: mapSession(session),
    });

    return res.status(201).json({
      success: true,
      session: mapSession(session),
      messages: messages.map(mapMessage),
    });
  } catch (error) {
    console.error('[chatbot-live] requestManualAgent', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to request agent' });
  }
};

exports.getMySession = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    await expireStaleRequestingSessions();
    if (!isCustomerRole(req.user)) {
      return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const projectId = resolveProjectId(req);
    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }
    const session = await ChatbotLiveSession.findOne({
      where: {
        customerUserId: Number(req.user.id),
        projectId,
        status: { [Op.in]: ['requesting', 'active'] },
      },
      order: [['id', 'DESC']],
    });
    if (!session) {
      return res.json({ success: true, session: null, messages: [] });
    }
    const messages = await ChatbotLiveMessage.findAll({
      where: { sessionId: session.id },
      order: [['id', 'ASC']],
    });
    return res.json({
      success: true,
      session: mapSession(session),
      messages: messages.map(mapMessage),
    });
  } catch (error) {
    console.error('[chatbot-live] getMySession', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load session' });
  }
};

exports.customerSendMessage = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    if (!isCustomerRole(req.user)) {
      return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    const sessionId = Number(req.params.sessionId);
    const text = String(req.body?.message || req.body?.body || '').trim();
    if (!sessionId || !text) {
      return res.status(400).json({ success: false, message: 'sessionId and message are required' });
    }
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session || Number(session.customerUserId) !== Number(req.user.id)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    if (session.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Session is closed' });
    }
    const row = await appendMessage(sessionId, {
      senderRole: 'customer',
      senderUserId: Number(req.user.id),
      body: text,
    });
    notifyLiveChatActivity(session, sessionId);
    return res.json({ success: true, message: mapMessage(row) });
  } catch (error) {
    console.error('[chatbot-live] customerSendMessage', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send message' });
  }
};

exports.endMySession = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    const sessionId = Number(req.params.sessionId);
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session || Number(session.customerUserId) !== Number(req.user.id)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    await ChatbotLiveSession.update({ status: 'closed' }, { where: { id: sessionId } });
    await appendMessage(sessionId, {
      senderRole: 'system',
      senderUserId: null,
      body: 'Customer ended the live chat session.',
    });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to end session' });
  }
};

exports.listAgentQueue = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    await expireStaleRequestingSessions();
    if (!isChatbotAgent(req.user)) {
      return res.status(403).json({ success: false, message: 'Chatbot agent access only' });
    }
    const status = String(req.query.status || 'requesting').toLowerCase();
    const where = {};
    if (status === 'active') {
      where.status = 'active';
      where.assignedAgentId = Number(req.user.id);
    } else if (status === 'requesting') {
      where.status = 'requesting';
    } else if (status === 'history') {
      where.status = 'closed';
      where.assignedAgentId = Number(req.user.id);
    } else {
      where.status = status;
    }

    const sessions = await ChatbotLiveSession.findAll({
      where,
      order: [['lastMessageAt', 'DESC'], ['id', 'DESC']],
      limit: Math.min(100, parseInt(String(req.query.limit || '50'), 10) || 50),
    });

    return res.json({
      success: true,
      sessions: sessions.map((s) => mapSession(s)),
    });
  } catch (error) {
    console.error('[chatbot-live] listAgentQueue', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to list sessions' });
  }
};

exports.acceptSession = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    if (!isChatbotAgent(req.user)) {
      return res.status(403).json({ success: false, message: 'Chatbot agent access only' });
    }
    const sessionId = Number(req.params.sessionId);
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session || session.status !== 'requesting') {
      return res.status(400).json({ success: false, message: 'Session not available' });
    }
    const agentId = Number(req.user.id);
    const [claimed] = await ChatbotLiveSession.update(
      { status: 'active', assignedAgentId: agentId, lastMessageAt: new Date() },
      { where: { id: sessionId, status: 'requesting' } }
    );
    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: 'This request was already accepted by another agent',
      });
    }
    const agentName = String(req.user.name || 'Agent').trim();
    await appendMessage(sessionId, {
      senderRole: 'system',
      senderUserId: agentId,
      body: `${agentName} joined the chat. You are now connected with a manual assistant.`,
    });
    const updated = await ChatbotLiveSession.findByPk(sessionId);
    const messages = await ChatbotLiveMessage.findAll({
      where: { sessionId },
      order: [['id', 'ASC']],
    });
    const sessionPayload = mapSession(updated);
    broadcastLiveEvent('chatbot-live:accepted', {
      sessionId,
      session: sessionPayload,
      agentId,
    });
    emitToUser(Number(updated.customerUserId), 'chatbot-live:session-update', {
      session: sessionPayload,
      messages: messages.map(mapMessage),
    });
    return res.json({
      success: true,
      session: sessionPayload,
      messages: messages.map(mapMessage),
    });
  } catch (error) {
    console.error('[chatbot-live] acceptSession', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to accept session' });
  }
};

exports.agentSendMessage = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    if (!isChatbotAgent(req.user)) {
      return res.status(403).json({ success: false, message: 'Chatbot agent access only' });
    }
    const sessionId = Number(req.params.sessionId);
    const text = String(req.body?.message || req.body?.body || '').trim();
    if (!sessionId || !text) {
      return res.status(400).json({ success: false, message: 'sessionId and message are required' });
    }
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session || session.status !== 'active' || Number(session.assignedAgentId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Not assigned to this session' });
    }
    const row = await appendMessage(sessionId, {
      senderRole: 'agent',
      senderUserId: Number(req.user.id),
      body: text,
    });
    notifyLiveChatActivity(session, sessionId);
    return res.json({ success: true, message: mapMessage(row) });
  } catch (error) {
    console.error('[chatbot-live] agentSendMessage', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send message' });
  }
};

exports.getSessionMessages = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    const sessionId = Number(req.params.sessionId);
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    const role = normalizeRole(req.user);
    const uid = Number(req.user.id);
    const allowed =
      isChatbotAgent(req.user) ||
      (isCustomerRole(req.user) && Number(session.customerUserId) === uid);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (isChatbotAgent(req.user) && session.status === 'active' && Number(session.assignedAgentId) !== uid) {
      return res.status(403).json({ success: false, message: 'Not assigned to this session' });
    }
    const messages = await ChatbotLiveMessage.findAll({
      where: { sessionId },
      order: [['id', 'ASC']],
    });
    return res.json({
      success: true,
      session: mapSession(session),
      messages: messages.map(mapMessage),
    });
  } catch (error) {
    console.error('[chatbot-live] getSessionMessages', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load messages' });
  }
};

exports.closeSessionAsAgent = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    if (!isChatbotAgent(req.user)) {
      return res.status(403).json({ success: false, message: 'Chatbot agent access only' });
    }
    const sessionId = Number(req.params.sessionId);
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session || Number(session.assignedAgentId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Not assigned to this session' });
    }
    await ChatbotLiveSession.update({ status: 'closed' }, { where: { id: sessionId } });
    await appendMessage(sessionId, {
      senderRole: 'system',
      senderUserId: Number(req.user.id),
      body: 'Agent ended the live chat session.',
    });
    emitToUser(Number(session.customerUserId), 'chatbot-live:session-ended', {
      sessionId,
    });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to close session' });
  }
};

exports.getSessionHistory = async (req, res) => {
  try {
    await ensureChatbotLiveSchema();
    const sessionId = Number(req.params.sessionId);
    const session = await ChatbotLiveSession.findByPk(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    const role = normalizeRole(req.user);
    if (role === 'chatbot_agent' && Number(session.assignedAgentId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (isCustomerRole(req.user) && Number(session.customerUserId) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const messages = await ChatbotLiveMessage.findAll({
      where: { sessionId },
      order: [['id', 'ASC']],
    });
    let agent = null;
    if (session.assignedAgentId) {
      agent = await User.findByPk(session.assignedAgentId, { attributes: ['id', 'name', 'email'] });
    }
    return res.json({
      success: true,
      session: mapSession(session, {
        agent: agent ? { id: agent.id, name: agent.name, email: agent.email } : null,
      }),
      messages: messages.map(mapMessage),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to load history' });
  }
};
