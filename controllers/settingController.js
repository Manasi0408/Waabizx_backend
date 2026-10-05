const Setting = require("../models/Setting");

/**
 * GET SETTINGS
 * GET /api/settings
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await Setting.findOne();

    return res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error("Get Settings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch settings",
    });
  }
};

/**
 * CREATE OR UPDATE SETTINGS
 * POST /api/settings
 */
exports.saveSettings = async (req, res) => {
  try {
    const {
      companyName,
      whatsappNumber,
      timezone,
      adminName,
      adminEmail,
    } = req.body;

    // Basic validation
    if (!companyName || !whatsappNumber || !timezone || !adminName || !adminEmail) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // Check if settings already exist
    let settings = await Setting.findOne();

    if (settings) {
      // Update
      await settings.update({
        companyName,
        whatsappNumber,
        timezone,
        adminName,
        adminEmail,
      });
    } else {
      // Create
      settings = await Setting.create({
        companyName,
        whatsappNumber,
        timezone,
        adminName,
        adminEmail,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Settings saved successfully",
      data: settings,
    });
  } catch (error) {
    console.error("Save Settings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save settings",
    });
  }
};
