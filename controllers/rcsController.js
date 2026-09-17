const rcsService = require('../services/rcsService');
const { requireProjectId } = require('../utils/projectScope');

exports.getChannels = async (_req, res) => {
  return res.json({
    success: true,
    channels: ['whatsapp', 'rcs', 'sms'],
    rcsProvider: rcsService.getProvider(),
    rcsStatus: rcsService.getProvider() === 'google' ? 'live' : 'mock',
  });
};

exports.getSettings = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const settings = await rcsService.getOrCreateSettings(projectId);
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const settings = await rcsService.updateSettings(projectId, req.body || {});
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.send = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const body = req.body || {};
    const channel = String(body.channel || 'rcs').toLowerCase();

    if (channel === 'whatsapp') {
      return res.status(400).json({
        success: false,
        message: 'Use existing WhatsApp send APIs for channel=whatsapp',
      });
    }

    if (channel !== 'rcs' && channel !== 'sms') {
      return res.status(400).json({ success: false, message: 'Unsupported channel' });
    }

    if (channel === 'sms') {
      return res.status(501).json({
        success: false,
        message: 'SMS channel scaffolded — not configured yet',
      });
    }

    const result = await rcsService.createAndSend({
      projectId,
      phone: body.to || body.phone,
      contactId: body.contactId || null,
      contactName: body.contactName || body.name || null,
      messageType: body.messageType || body.type || 'text',
      message: body.message || body.text || '',
      content: body.content || body.payload || null,
      channel: 'rcs',
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to send RCS message',
    });
  }
};

exports.listConversations = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const conversations = await rcsService.listConversations(projectId);
    return res.json({ success: true, conversations });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listMessages = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const messages = await rcsService.listMessages(projectId, {
      phone: req.query.phone,
      contactId: req.query.contactId,
    });
    return res.json({ success: true, messages });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.mockWebhook = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { messageId, status } = req.body || {};
    if (!messageId || !status) {
      return res.status(400).json({ success: false, message: 'messageId and status required' });
    }
    const message = await rcsService.applyStatusUpdate({ messageId, status, projectId });
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    return res.json({ success: true, message });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.buttonClick = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { messageId, buttonText, id } = req.body || {};
    const result = await rcsService.recordButtonClick({
      messageId: messageId || id,
      buttonText: buttonText || 'YES',
      projectId,
    });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getStats = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const channel = String(req.query.channel || 'rcs');
    const stats = await rcsService.getStats(projectId, channel);
    return res.json({ success: true, stats });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.seedDemoStats = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const stats = await rcsService.seedDemoStats(projectId);
    return res.json({ success: true, stats });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.seedInbox = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const conversations = await rcsService.seedSampleInbox(projectId);
    return res.json({ success: true, conversations });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listTemplates = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const templates = await rcsService.listTemplates(projectId, req.query.channel || 'rcs');
    return res.json({ success: true, templates });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const template = await rcsService.createTemplate({
      projectId,
      channel: req.body?.channel || 'rcs',
      type: req.body?.type,
      name: req.body?.name,
      content: req.body?.content,
    });
    return res.status(201).json({ success: true, template });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listCampaigns = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaigns = await rcsService.listCampaigns(projectId);
    return res.json({ success: true, campaigns });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createCampaign = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaign = await rcsService.createCampaign({
      projectId,
      userId: req.user?.id,
      name: req.body?.name,
      channel: req.body?.channel || 'rcs',
      messageType: req.body?.messageType || req.body?.type || 'text',
      content: req.body?.content || {
        message: req.body?.message,
        payload: req.body?.payload,
        recipients: req.body?.recipients,
      },
      recipients: req.body?.recipients || [],
    });
    return res.status(201).json({ success: true, campaign });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendCampaign = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const result = await rcsService.sendCampaign({
      projectId,
      campaignId: req.params.id,
      recipients: req.body?.recipients || [],
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/** Public Google webhook placeholder — returns 200 now */
exports.handleRcsWebhook = async (req, res) => {
  try {
    // Later: parse Google RBM events and update rcs_messages + channel_stats
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(200);
  }
};
