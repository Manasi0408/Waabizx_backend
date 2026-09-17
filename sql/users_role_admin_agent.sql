-- Ensure users table has role column for admin/agent login
-- Run in your database (e.g. aisensy_db) if the column does not exist.
-- Sequelize User model uses table "Users" and already defines role; this is for raw MySQL users table if different.

-- If using table named "users" (lowercase):
-- ALTER TABLE users ADD COLUMN role ENUM('admin','agent') DEFAULT 'agent';

-- If using Sequelize "Users" table, role may already exist as ENUM('admin','manager','agent','user').
-- Example data:
-- INSERT INTO Users (name, email, password, role) VALUES ('Admin', 'admin@gmail.com', '<hashed>', 'admin');
-- INSERT INTO Users (name, email, password, role) VALUES ('Agent1', 'agent@gmail.com', '<hashed>', 'agent');
-- Use Register page or hash password (bcrypt) before inserting.
