-- Agent Live Chat tables for WhatsApp CRM (separate from app's Messages/conversations)
-- Run this in your MySQL database (e.g. aisensy_db)

CREATE TABLE IF NOT EXISTS agent_conversations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20),
  customer_name VARCHAR(100),
  status ENUM('active','closed','requesting','intervened') DEFAULT 'active',
  assigned_agent INT,
  last_message TEXT,
  last_message_time DATETIME,
  unread_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT,
  sender ENUM('customer','agent'),
  message TEXT,
  message_type VARCHAR(20),
  media_url TEXT,
  created_at DATETIME
);
