# Fix: Template Not Saving to Database

## 🔍 Quick Diagnosis

Run this test script to check if the database is working:

```bash
cd backend
node test-inbox-save.js
```

This will:
1. ✅ Check if `InboxMessages` table exists
2. ✅ Create it if missing
3. ✅ Test saving a message
4. ✅ Verify it was saved
5. ✅ Show any errors

---

## 🛠️ Common Fixes

### Fix 1: Table Doesn't Exist

**Symptoms:** Error: `Table 'database.InboxMessages' doesn't exist`

**Solution A: Restart Server**
```bash
# Stop your Node.js server (Ctrl+C)
# Start it again
npm start
```

The server will automatically create the table on startup.

**Solution B: Create Table Manually**
Run this SQL in your MySQL database:

```sql
CREATE TABLE IF NOT EXISTS `InboxMessages` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `contactId` INT NOT NULL,
  `userId` INT NOT NULL,
  `direction` ENUM('incoming', 'outgoing') NOT NULL,
  `message` TEXT NOT NULL,
  `type` ENUM('text', 'image', 'video', 'audio', 'document') DEFAULT 'text',
  `status` ENUM('sent', 'delivered', 'read', 'failed') DEFAULT 'sent',
  `waMessageId` VARCHAR(255) NULL,
  `timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `contactId` (`contactId`),
  INDEX `userId` (`userId`),
  CONSTRAINT `InboxMessages_ibfk_1` FOREIGN KEY (`contactId`) REFERENCES `Contacts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `InboxMessages_ibfk_2` FOREIGN KEY (`userId`) REFERENCES `Users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### Fix 2: Foreign Key Constraint Error

**Symptoms:** Error: `Cannot add or update a child row: a foreign key constraint fails`

**Solution:** Verify Contact and User exist:

```sql
-- Check if contact exists
SELECT id, phone, userId FROM Contacts WHERE id = YOUR_CONTACT_ID;

-- Check if user exists
SELECT id, email FROM Users WHERE id = YOUR_USER_ID;
```

If they don't exist, the template send will create the contact automatically, but make sure the user exists.

---

### Fix 3: Check Server Logs

When you send a template, check your Node.js server console. You should see:

**✅ Success:**
```
💾 Attempting to save template to InboxMessages: {...}
✅ Template message saved to InboxMessages (ID: 123)
```

**❌ Error:**
```
❌ CRITICAL: Database Error saving template!
Error Type: [error type]
Error Message: [error message]
```

The updated code now shows detailed error messages that will tell you exactly what's wrong.

---

## 🧪 Test Steps

1. **Run the test script:**
   ```bash
   cd backend
   node test-inbox-save.js
   ```

2. **Send a template via API:**
   ```bash
   curl -X POST http://localhost:5000/api/messages/send-template ^
     -H "Content-Type: application/json" ^
     -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
     -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
   ```

3. **Check server console** for save confirmation or errors

4. **Verify in database:**
   ```sql
   SELECT * FROM InboxMessages 
   WHERE message LIKE 'Template:%' 
   ORDER BY id DESC 
   LIMIT 1;
   ```

---

## ✅ What Changed

The code now:
- ✅ Automatically creates the table if it doesn't exist
- ✅ Shows detailed error messages
- ✅ Verifies contact and user before saving
- ✅ Retries save after table creation
- ✅ Logs all steps for debugging

---

## 📞 Still Not Working?

1. **Check server logs** - Look for the detailed error messages
2. **Run test script** - `node test-inbox-save.js`
3. **Check database connection** - Make sure `.env` has correct DB credentials
4. **Verify table exists** - Run `SHOW TABLES LIKE 'InboxMessages';` in MySQL

The error messages will now tell you exactly what's wrong!

