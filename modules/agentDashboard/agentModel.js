const db = require("../../config/db");

const AgentModel = {
  getTodayMessages: (callback) => {
    const query =
      "SELECT COUNT(*) AS total FROM agent_messages WHERE DATE(created_at)=CURDATE()";
    db.query(query)
      .then(([rows]) => {
        callback(null, rows[0].total);
      })
      .catch((err) => {
        callback(err, null);
      });
  },
};

module.exports = AgentModel;
