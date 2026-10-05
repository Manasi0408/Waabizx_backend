-- Message table for chat (table name: message)
-- Run in your database (e.g. aisensy_db) if the table does not exist yet

CREATE TABLE IF NOT EXISTS message (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT,
  sender ENUM('customer','agent') NOT NULL,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- If your existing conversations table does not have agent_id or status, run (one-time):
-- ALTER TABLE conversations ADD COLUMN agent_id INT NULL;
-- ALTER TABLE conversations ADD COLUMN last_message TEXT NULL;
-- (Status should allow: 'requesting','active','intervened','closed')
