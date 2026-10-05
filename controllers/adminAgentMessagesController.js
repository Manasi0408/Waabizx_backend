const db = require("../config/db");

// Admin: all messages with phone from conversations
exports.getAllMessages = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT m.*, c.phone
       FROM message m
       JOIN conversations c ON m.conversation_id = c.id
       ORDER BY m.id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Agent: only messages from conversations assigned to this agent
exports.getAgentMessages = async (req, res) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId) {
      return res.status(400).json({ error: "agentId query is required" });
    }
    const [rows] = await db.query(
      `SELECT m.*, c.phone
       FROM message m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.agent_id = ?
       ORDER BY m.id DESC`,
      [agentId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
