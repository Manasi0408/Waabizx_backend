const RcsMessage = require('../models/RcsMessage');
const RcsSettings = require('../models/RcsSettings');
const ChannelStat = require('../models/ChannelStat');
const MessageTemplateChannel = require('../models/MessageTemplateChannel');
const RcsCampaign = require('../models/RcsCampaign');

const getProvider = () => String(process.env.RCS_PROVIDER || 'mock').toLowerCase();

const parseJson = (raw, fallback = null) => {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
};

const stringifyContent = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const ensureStats = async (projectId, channel = 'rcs') => {
  const [row] = await ChannelStat.findOrCreate({
    where: { projectId, channel },
    defaults: { sent: 0, delivered: 0, read: 0, failed: 0, clicked: 0 },
  });
  return row;
};

const bumpStat = async (projectId, channel, field, by = 1) => {
  const row = await ensureStats(projectId, channel);
  await row.increment(field, { by });
  await row.reload();
  return row;
};

const formatMessage = (row) => {
  const plain = row?.toJSON ? row.toJSON() : row;
  return {
    ...plain,
    content: parseJson(plain.content, plain.content),
  };
};

/** Mock Google RBM send — swap body when RCS_PROVIDER=google */
const mockSend = async ({ to, text, messageType, content }) => ({
  success: true,
  provider: 'mock',
  messageId: `RCS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  status: 'sent',
  to,
  text: text || '',
  messageType: messageType || 'text',
  content: content || null,
  timestamp: new Date().toISOString(),
});

const googleSend = async () => {
  throw new Error('RCS Google RBM is not configured yet. Set RCS_PROVIDER=mock until approval.');
};

exports.getProvider = getProvider;

exports.sendMessage = async (data) => {
  const provider = getProvider();
  if (provider === 'google') {
    return googleSend(data);
  }
  return mockSend(data);
};

exports.getOrCreateSettings = async (projectId) => {
  const [row] = await RcsSettings.findOrCreate({
    where: { projectId },
    defaults: {
      agentId: '',
      apiKey: '',
      webhookUrl: '',
      brandName: '',
      provider: getProvider(),
      isActive: false,
    },
  });
  return row;
};

exports.updateSettings = async (projectId, body = {}) => {
  const row = await exports.getOrCreateSettings(projectId);
  const updates = {};
  if (body.agentId != null) updates.agentId = String(body.agentId);
  if (body.apiKey != null) updates.apiKey = String(body.apiKey);
  if (body.webhookUrl != null) updates.webhookUrl = String(body.webhookUrl);
  if (body.brandName != null) updates.brandName = String(body.brandName);
  if (body.provider != null) updates.provider = String(body.provider);
  if (body.isActive != null) updates.isActive = Boolean(body.isActive);
  await row.update(updates);
  return row;
};

exports.createAndSend = async ({
  projectId,
  phone,
  contactId = null,
  contactName = null,
  messageType = 'text',
  message = '',
  content = null,
  campaignId = null,
  channel = 'rcs',
}) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) {
    const err = new Error('Phone number is required');
    err.status = 400;
    throw err;
  }

  const providerResult = await exports.sendMessage({
    phone: digits,
    to: digits,
    text: message,
    messageType,
    content,
  });

  const row = await RcsMessage.create({
    projectId,
    contactId,
    phone: digits,
    contactName: contactName || null,
    channel,
    messageType,
    message: message || null,
    content: stringifyContent(content),
    direction: 'outgoing',
    status: providerResult.status || 'sent',
    providerMessageId: providerResult.messageId || null,
    campaignId,
  });

  await bumpStat(projectId, channel, 'sent', 1);

  return { message: formatMessage(row), provider: providerResult };
};

exports.listConversations = async (projectId) => {
  const rows = await RcsMessage.findAll({
    where: { projectId },
    order: [['id', 'DESC']],
    limit: 500,
  });

  const map = new Map();
  for (const row of rows) {
    const key = row.phone || String(row.contactId || row.id);
    if (!map.has(key)) {
      map.set(key, {
        phone: row.phone,
        contactId: row.contactId,
        contactName: row.contactName || row.phone,
        channel: row.channel,
        lastMessage: row.message || row.messageType,
        lastStatus: row.status,
        lastAt: row.createdAt,
        unread: 0,
      });
    }
  }
  return Array.from(map.values());
};

exports.listMessages = async (projectId, { phone, contactId } = {}) => {
  const where = { projectId };
  if (phone) where.phone = String(phone).replace(/\D/g, '');
  if (contactId) where.contactId = contactId;
  const rows = await RcsMessage.findAll({
    where,
    order: [['id', 'ASC']],
    limit: 500,
  });
  return rows.map(formatMessage);
};

exports.applyStatusUpdate = async ({ messageId, status, projectId }) => {
  const row = await RcsMessage.findOne({
    where: projectId
      ? { providerMessageId: messageId, projectId }
      : { providerMessageId: messageId },
  });
  if (!row) return null;

  const prev = row.status;
  await row.update({ status });

  if (status === 'delivered' && prev !== 'delivered') {
    await bumpStat(row.projectId, row.channel, 'delivered', 1);
  }
  if (status === 'read' && prev !== 'read') {
    await bumpStat(row.projectId, row.channel, 'read', 1);
  }
  if (status === 'failed' && prev !== 'failed') {
    await bumpStat(row.projectId, row.channel, 'failed', 1);
  }

  return formatMessage(row);
};

exports.recordButtonClick = async ({ messageId, buttonText, projectId }) => {
  const row = await RcsMessage.findOne({
    where: projectId
      ? { providerMessageId: messageId, projectId }
      : { id: Number(messageId) || 0, projectId },
  });
  if (!row && projectId) {
    const byId = await RcsMessage.findOne({ where: { id: Number(messageId), projectId } });
    if (!byId) return null;
    await byId.update({ clickedButton: buttonText });
    await bumpStat(projectId, byId.channel, 'clicked', 1);
    const reply = await RcsMessage.create({
      projectId,
      contactId: byId.contactId,
      phone: byId.phone,
      contactName: byId.contactName,
      channel: byId.channel,
      messageType: 'text',
      message: `User clicked: ${buttonText}`,
      content: null,
      direction: 'incoming',
      status: 'delivered',
      providerMessageId: `RCS_CLICK_${Date.now()}`,
    });
    return { message: formatMessage(byId), reply: formatMessage(reply) };
  }

  if (!row) return null;
  await row.update({ clickedButton: buttonText });
  await bumpStat(row.projectId, row.channel, 'clicked', 1);
  const reply = await RcsMessage.create({
    projectId: row.projectId,
    contactId: row.contactId,
    phone: row.phone,
    contactName: row.contactName,
    channel: row.channel,
    messageType: 'text',
    message: `User clicked: ${buttonText}`,
    content: null,
    direction: 'incoming',
    status: 'delivered',
    providerMessageId: `RCS_CLICK_${Date.now()}`,
  });
  return { message: formatMessage(row), reply: formatMessage(reply) };
};

exports.getStats = async (projectId, channel = 'rcs') => {
  const row = await ensureStats(projectId, channel);
  return row.toJSON ? row.toJSON() : row;
};

exports.seedDemoStats = async (projectId) => {
  const row = await ensureStats(projectId, 'rcs');
  await row.update({ sent: 100, delivered: 80, read: 65, failed: 10, clicked: 12 });
  return row.toJSON();
};

exports.listTemplates = async (projectId, channel = 'rcs') => {
  const rows = await MessageTemplateChannel.findAll({
    where: { projectId, channel },
    order: [['id', 'DESC']],
  });
  return rows.map((r) => {
    const plain = r.toJSON();
    return { ...plain, content: parseJson(plain.content, plain.content) };
  });
};

exports.createTemplate = async ({ projectId, channel = 'rcs', type, name, content }) => {
  const row = await MessageTemplateChannel.create({
    projectId,
    channel,
    type: type || 'text',
    name: name || 'Untitled',
    content: stringifyContent(content),
  });
  const plain = row.toJSON();
  return { ...plain, content: parseJson(plain.content, plain.content) };
};

exports.createCampaign = async ({
  projectId,
  userId,
  name,
  channel = 'rcs',
  messageType = 'text',
  content,
  recipients = [],
}) => {
  const campaign = await RcsCampaign.create({
    projectId,
    name: name || 'RCS Campaign',
    channel,
    messageType,
    content: stringifyContent(content),
    status: 'draft',
    totalRecipients: Array.isArray(recipients) ? recipients.length : 0,
    createdBy: userId || null,
  });
  return campaign.toJSON();
};

exports.sendCampaign = async ({ projectId, campaignId, recipients = [] }) => {
  const campaign = await RcsCampaign.findOne({ where: { id: campaignId, projectId } });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  const content = parseJson(campaign.content, {});
  const list = Array.isArray(recipients) && recipients.length
    ? recipients
    : content.recipients || [];

  let sent = 0;
  let failed = 0;
  const results = [];

  for (const item of list) {
    const phone = typeof item === 'string' ? item : item.phone;
    const contactName = typeof item === 'object' ? item.name : null;
    try {
      const result = await exports.createAndSend({
        projectId,
        phone,
        contactName,
        messageType: campaign.messageType,
        message: content.message || content.text || campaign.name,
        content: content.payload || content,
        campaignId: campaign.id,
        channel: campaign.channel,
      });
      sent += 1;
      results.push({ phone, ok: true, id: result.message.id });
    } catch (e) {
      failed += 1;
      results.push({ phone, ok: false, error: e.message });
      await bumpStat(projectId, campaign.channel, 'failed', 1);
    }
  }

  await campaign.update({
    status: 'completed',
    totalRecipients: list.length,
    sent,
    failed,
    delivered: 0,
  });

  return { campaign: campaign.toJSON(), results };
};

exports.listCampaigns = async (projectId) => {
  const rows = await RcsCampaign.findAll({
    where: { projectId },
    order: [['id', 'DESC']],
  });
  return rows.map((r) => r.toJSON());
};

exports.seedSampleInbox = async (projectId) => {
  const existing = await RcsMessage.count({ where: { projectId } });
  if (existing > 0) {
    return exports.listConversations(projectId);
  }

  const sampleCard = {
    type: 'card',
    header: { image: 'https://picsum.photos/400/250' },
    title: 'Personal Loan',
    description: 'Get loan up to ₹10L with instant approval',
    buttons: [
      { type: 'reply', text: 'Apply Now' },
      { type: 'url', text: 'Learn More', url: 'https://example.com' },
    ],
  };

  const sampleCarousel = {
    type: 'carousel',
    cards: [
      {
        title: 'Card 1',
        description: 'Offer A',
        image: 'https://picsum.photos/400/250?1',
        buttons: [{ type: 'reply', text: 'YES' }],
      },
      {
        title: 'Card 2',
        description: 'Offer B',
        image: 'https://picsum.photos/400/250?2',
        buttons: [{ type: 'reply', text: 'INTERESTED' }],
      },
      {
        title: 'Card 3',
        description: 'Offer C',
        image: 'https://picsum.photos/400/250?3',
        buttons: [{ type: 'reply', text: 'NO' }],
      },
    ],
  };

  await exports.createAndSend({
    projectId,
    phone: '919876543210',
    contactName: 'John (RCS Demo)',
    messageType: 'text',
    message: 'Hello from Waabizx RCS mock!',
  });
  await exports.createAndSend({
    projectId,
    phone: '919876543210',
    contactName: 'John (RCS Demo)',
    messageType: 'card',
    message: sampleCard.title,
    content: sampleCard,
  });
  await exports.createAndSend({
    projectId,
    phone: '919876543210',
    contactName: 'John (RCS Demo)',
    messageType: 'carousel',
    message: 'Carousel offers',
    content: sampleCarousel,
  });

  await MessageTemplateChannel.findOrCreate({
    where: { projectId, channel: 'rcs', name: 'Personal Loan Card' },
    defaults: {
      type: 'card',
      content: stringifyContent(sampleCard),
    },
  });

  return exports.listConversations(projectId);
};
