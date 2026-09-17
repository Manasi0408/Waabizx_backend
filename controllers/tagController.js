const tagService = require('../services/tagService');
const { requireProjectId } = require('../utils/projectScope');

exports.createTag = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { name, color } = req.body;
    const tag = await tagService.createTag({
      projectId,
      name,
      color,
      createdBy: req.user?.id,
    });

    res.status(201).json({ success: true, tag });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.getTags = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const tags = await tagService.listTags(projectId);
    res.json({ success: true, tags });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.updateTag = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const tag = await tagService.updateTag({
      tagId: req.params.id,
      projectId,
      name: req.body.name,
      color: req.body.color,
    });

    res.json({ success: true, tag });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.deleteTag = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const result = await tagService.deleteTag({
      tagId: req.params.id,
      projectId,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.assignContactTag = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { contactId, tagId, phone } = req.body;
    if (!tagId || (!contactId && !phone)) {
      return res.status(400).json({
        success: false,
        message: 'tagId and contactId or phone are required',
      });
    }

    const result = await tagService.assignTagToContact({
      contactId,
      tagId,
      phone,
      userId: req.user.id,
      projectId,
    });

    res.status(result.created ? 201 : 200).json({
      success: true,
      created: result.created,
      contactId: result.contactId,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.removeContactTag = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const { contactId, tagId, phone } = req.body;
    if (!tagId || (!contactId && !phone)) {
      return res.status(400).json({
        success: false,
        message: 'tagId and contactId or phone are required',
      });
    }

    const result = await tagService.removeTagFromContact({
      contactId,
      tagId,
      phone,
      userId: req.user.id,
      projectId,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

exports.getContactTags = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const contactId = req.params.contactId;
    const { phone } = req.query;
    const tags = await tagService.getTagsForContact(
      contactId,
      projectId,
      phone,
      req.user?.id
    );

    res.json({ success: true, tags });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};
