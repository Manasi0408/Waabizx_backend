const whatsappButtonService = require('../services/whatsappButtonService');
const { requireProjectId } = require('../utils/projectScope');

exports.listWhatsAppButtons = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const buttons = await whatsappButtonService.listButtons(projectId, req);
    return res.json({
      success: true,
      buttons,
      used: buttons.length,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load WhatsApp buttons',
    });
  }
};

exports.createWhatsAppButton = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const button = await whatsappButtonService.createButton({
      projectId,
      userId: req.user?.id,
      body: req.body || {},
      req,
    });

    return res.status(201).json({ success: true, button });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to create WhatsApp button',
    });
  }
};

exports.deleteWhatsAppButton = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    await whatsappButtonService.deleteButton({
      projectId,
      id: req.params.id,
    });

    return res.json({ success: true, message: 'Button deleted' });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to delete WhatsApp button',
    });
  }
};

exports.publicRedirect = async (req, res) => {
  try {
    const publicId = String(req.params.publicId || '').trim();
    const button = await whatsappButtonService.getByPublicId(publicId);
    if (!button) {
      return res.status(404).send('WhatsApp button not found');
    }

    await whatsappButtonService.trackVisit(publicId, 'qr');
    const url = whatsappButtonService.buildWaMeUrl(button.phoneNumber, 'Hi');
    return res.redirect(302, url);
  } catch (error) {
    return res.status(500).send('Unable to open WhatsApp chat');
  }
};

exports.publicTrackVisit = async (req, res) => {
  try {
    const publicId = String(req.params.publicId || '').trim();
    const type = String(req.query.type || 'widget').toLowerCase() === 'qr' ? 'qr' : 'widget';
    await whatsappButtonService.trackVisit(publicId, type);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  } catch {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
};
