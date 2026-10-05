const AgentModel = require("./agentModel");
const { getPhoneData } = require("./whatsappService");

exports.getAgentDashboard = async (req, res) => {
  try {
    const apiData = await getPhoneData();
    let quality = "HIGH";
    if (apiData && apiData.quality_rating) {
      quality = apiData.quality_rating;
    }
    AgentModel.getTodayMessages((err, total) => {
      if (err) {
        return res.status(500).json({ error: "Database error" });
      }
      const dailyLimit = 100000;
      const remaining = dailyLimit - total;
      res.json({
        whatsapp_status: "LIVE",
        quality_rating: quality,
        remaining_quota: remaining,
      });
    });
  } catch (error) {
    res.json({
      whatsapp_status: "OFFLINE",
    });
  }
};
