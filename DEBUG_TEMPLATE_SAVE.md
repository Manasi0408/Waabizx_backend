# Debug: Template Not Saving to InboxMessages

## 🔍 Step 1: Check if Table Exists

Run this SQL query in your MySQL database:

```sql
SHOW TABLES LIKE 'InboxMessages';
```

If the table doesn't exist, you'll need to create it or let Sequelize create it.

---

## 🔧 Step 2: Check Server Logs

When you send a template, check your Node.js server console for:

1. **Success message:**
   ```
   ✅ Template sent via Meta API: {...}
   ✅ Template message saved to InboxMessages (ID: 123)
   ```

2. **Error message:**
   ```
   ❌ Database Error saving template: [error details]
   ```

---

## 🛠️ Step 3: Verify Table Structure

Check if the table has the correct structure:

```sql
DESCRIBE InboxMessages;
```

Expected columns:
- `id` (INT, Primary Key, Auto Increment)
- `contactId` (INT, NOT NULL)
- `userId` (INT, NOT NULL)
- `direction` (ENUM: 'incoming', 'outgoing')
- `message` (TEXT, NOT NULL)
- `type` (ENUM: 'text', 'image', 'video', 'audio', 'document')
- `status` (ENUM: 'sent', 'delivered', 'read', 'failed')
- `waMessageId` (VARCHAR, NULL)
- `timestamp` (DATETIME)
- `createdAt` (DATETIME)
- `updatedAt` (DATETIME)

---

## 🔨 Step 4: Create Table Manually (If Missing)

If the table doesn't exist, run this SQL:

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

## 🧪 Step 5: Test Database Connection

Add this test endpoint to verify database access:

```javascript
// In messageController.js (temporary test)
exports.testInboxMessage = async (req, res) => {
  try {
    const testMessage = await InboxMessage.create({
      contactId: 1, // Use a valid contact ID
      userId: 1,    // Use a valid user ID
      direction: "outgoing",
      message: "Test message",
      type: "text",
      status: "sent",
      timestamp: new Date()
    });
    return res.json({ success: true, message: testMessage });
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
};
```

Then test:
```bash
curl -X GET http://localhost:5000/api/messages/test-inbox ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## 📋 Step 6: Check Common Issues

### Issue 1: Foreign Key Constraint
**Error:** `Cannot add or update a child row: a foreign key constraint fails`

**Solution:** Ensure the `contactId` and `userId` exist:
```sql
SELECT id FROM Contacts WHERE id = YOUR_CONTACT_ID;
SELECT id FROM Users WHERE id = YOUR_USER_ID;
```

### Issue 2: Table Doesn't Exist
**Error:** `Table 'database.InboxMessages' doesn't exist`

**Solution:** Run the CREATE TABLE SQL from Step 4, or restart your server to trigger Sequelize sync.

### Issue 3: Column Type Mismatch
**Error:** `Incorrect column type` or `Data too long for column`

**Solution:** Check column types match the model definition.

---

## ✅ Step 7: Verify After Fix

After fixing the issue, send a template again and check:

1. **Server logs show:**
   ```
   ✅ Template message saved to InboxMessages (ID: XXX)
   ```

2. **Database query:**
   ```sql
   SELECT * FROM InboxMessages 
   WHERE message LIKE 'Template:%' 
   ORDER BY id DESC 
   LIMIT 1;
   ```

3. **API response includes:**
   ```json
   {
     "success": true,
     "msg": "Template sent successfully",
     "waMessageId": "wamid.xxx",
     "saved": true,
     "messageId": 123
   }
   ```

---

## 🚀 Quick Fix: Restart Server

Sometimes the table just needs to be synced. Try:

1. Stop your Node.js server
2. Restart it (this will trigger `syncDatabase()`)
3. Check console for: `✅ InboxMessage table verified/created.`
4. Try sending a template again

---

## 📞 Still Not Working?

If it's still not saving, check the server console for the detailed error message. The updated code now logs:
- Full error message
- Error name
- Stack trace
- Contact ID, User ID, and Template name

This will help identify the exact issue.

