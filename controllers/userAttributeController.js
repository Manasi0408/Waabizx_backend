const userAttributeService = require('../services/userAttributeService');
const { requireProjectId } = require('../utils/projectScope');

exports.getUserAttributes = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const attributes = await userAttributeService.listUserAttributes(projectId);
    res.json({ success: true, attributes });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.saveUserAttributes = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const attributes = await userAttributeService.saveUserAttributes(
      projectId,
      req.user?.id,
      req.body?.attributes
    );

    res.json({ success: true, attributes });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};
