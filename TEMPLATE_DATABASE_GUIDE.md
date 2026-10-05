# Where Template Messages Are Stored in Database

## 📊 Main Table: `InboxMessages`

When you send a template via `/api/messages/send-template`, the message is saved in the **`InboxMessages`** table.

### Table Structure:
```sql
InboxMessages
├── id (INTEGER, Primary Key)
├── contactId (INTEGER, Foreign Key → Contacts.id)
├── userId (INTEGER, Foreign Key → Users.id)
├── direction (ENUM: 'incoming' | 'outgoing')  ← Will be 'outgoing' for templates
├── message (TEXT)  ← Contains: "Template: {templateName}"
├── type (ENUM: 'text' | 'image' | 'video' | 'audio' | 'document')  ← Usually 'text'
├── status (ENUM: 'sent' | 'delivered' | 'read' | 'failed')  ← Starts as 'sent'
├── waMessageId (STRING)  ← WhatsApp Message ID from Meta API (e.g., "wamid.HBgN...")
├── timestamp (DATE)  ← When template was sent
├── createdAt (DATE)  ← Record creation time
└── updatedAt (DATE)  ← Last update time
```

### Example Record:
```sql
SELECT * FROM InboxMessages WHERE direction = 'outgoing' AND message LIKE 'Template:%';

-- Result:
id: 123
contactId: 45
userId: 1
direction: 'outgoing'
message: 'Template: hello_world'
type: 'text'
status: 'sent'
waMessageId: 'wamid.HBgNMTkxODIyNDI2MzM5FQIAERgSQjY1QkE2Q0Y3M0YwQkE2Q0Y3M0Y='
timestamp: '2024-01-15 10:30:00'
createdAt: '2024-01-15 10:30:00'
updatedAt: '2024-01-15 10:30:00'
```

---

## 🔍 How to Query Template Messages

### 1. Find All Sent Templates:
```sql
SELECT * FROM InboxMessages 
WHERE direction = 'outgoing' 
  AND message LIKE 'Template:%'
ORDER BY timestamp DESC;
```

### 2. Find Templates for a Specific Contact:
```sql
SELECT im.*, c.phone, c.name 
FROM InboxMessages im
JOIN Contacts c ON im.contactId = c.id
WHERE im.direction = 'outgoing'
  AND im.message LIKE 'Template:%'
  AND c.phone = '919822426339'
ORDER BY im.timestamp DESC;
```

### 3. Find Templates by Template Name:
```sql
SELECT * FROM InboxMessages 
WHERE message = 'Template: hello_world'
ORDER BY timestamp DESC;
```

### 4. Find Failed Template Sends:
```sql
SELECT * FROM InboxMessages 
WHERE direction = 'outgoing'
  AND message LIKE 'Template:%'
  AND status = 'failed'
ORDER BY timestamp DESC;
```

### 5. Get Template Statistics:
```sql
SELECT 
  COUNT(*) as total_templates_sent,
  COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
  COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
  COUNT(CASE WHEN status = 'read' THEN 1 END) as read,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
FROM InboxMessages 
WHERE direction = 'outgoing' 
  AND message LIKE 'Template:%';
```

---

## 📋 Other Tables Updated

### 1. **Contacts** Table
The `lastContacted` field is updated when a template is sent:

```sql
SELECT id, phone, name, lastContacted 
FROM Contacts 
WHERE phone = '919822426339';

-- lastContacted will be updated to the current timestamp
```

### 2. **Templates** Table (Optional)
If you're tracking template usage, you can update the `usageCount` field, but this is **NOT automatically done** by the current code.

---

## 🔄 Status Updates

When Meta sends webhook updates (delivered/read), the status in `InboxMessages` is updated:

- **Initial:** `status = 'sent'`
- **When delivered:** `status = 'delivered'` (via webhook)
- **When read:** `status = 'read'` (via webhook)
- **If failed:** `status = 'failed'`

---

## 📝 Example: Complete Flow

### Step 1: Send Template
```bash
POST /api/messages/send-template
{
  "phone": "919822426339",
  "templateName": "hello_world",
  "templateLanguage": "en_US"
}
```

### Step 2: Check Database
```sql
-- Find the sent template
SELECT * FROM InboxMessages 
WHERE waMessageId IS NOT NULL 
  AND message LIKE 'Template:%'
ORDER BY id DESC 
LIMIT 1;
```

### Step 3: Check Contact
```sql
-- Verify contact was updated
SELECT phone, name, lastContacted 
FROM Contacts 
WHERE phone = '919822426339';
```

---

## 🎯 Quick Reference

| What | Table | Field | Value |
|------|-------|-------|-------|
| **Template Message** | `InboxMessages` | `message` | `"Template: {name}"` |
| **Direction** | `InboxMessages` | `direction` | `'outgoing'` |
| **Status** | `InboxMessages` | `status` | `'sent'`, `'delivered'`, `'read'`, or `'failed'` |
| **WhatsApp ID** | `InboxMessages` | `waMessageId` | Meta API message ID |
| **Contact Info** | `Contacts` | `lastContacted` | Updated timestamp |
| **User** | `InboxMessages` | `userId` | User who sent the template |

---

## 💡 Tips

1. **Find Recent Templates:**
   ```sql
   SELECT * FROM InboxMessages 
   WHERE message LIKE 'Template:%' 
   ORDER BY createdAt DESC 
   LIMIT 10;
   ```

2. **Count Templates Sent Today:**
   ```sql
   SELECT COUNT(*) 
   FROM InboxMessages 
   WHERE message LIKE 'Template:%'
     AND DATE(timestamp) = CURDATE();
   ```

3. **Find Templates by User:**
   ```sql
   SELECT im.*, u.email 
   FROM InboxMessages im
   JOIN Users u ON im.userId = u.id
   WHERE im.message LIKE 'Template:%'
   ORDER BY im.timestamp DESC;
   ```

---

## ✅ Summary

**Main Table:** `InboxMessages`
- Contains all sent template messages
- `message` field: `"Template: {templateName}"`
- `direction`: `'outgoing'`
- `waMessageId`: WhatsApp message ID from Meta
- `status`: Tracks delivery status

**Also Updated:** `Contacts.lastContacted` timestamp

