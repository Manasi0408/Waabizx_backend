# How to Send Template Messages

## Prerequisites

1. **Template must be APPROVED** by Meta
2. **Authentication token** (from login)
3. **Environment variables** set:
   - `Phone_Number_ID` - Your WhatsApp Phone Number ID
   - `Whatsapp_Token` - Your Meta Permanent Token

---

## Step-by-Step Guide

### Step 1: Check Template Status

First, verify your template is approved:

```cmd
curl -X GET http://localhost:5000/api/templates/meta -H "Authorization: Bearer YOUR_TOKEN"
```

Look for templates with `"status": "APPROVED"`

---

### Step 2: Send Template Message

**Endpoint:** `POST /api/messages/send-template`

**Request Body:**
```json
{
  "phone": "918600137050",
  "templateName": "hello_world",
  "templateLanguage": "en_US",
  "templateParams": ["John"]  // Optional - only if template has variables
}
```

**CURL Command (Windows CMD):**
```cmd
curl -X POST http://localhost:5000/api/messages/send-template ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer YOUR_TOKEN" ^
-d "{\"phone\":\"918600137050\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

**With Parameters (if template has variables):**
```cmd
curl -X POST http://localhost:5000/api/messages/send-template ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer YOUR_TOKEN" ^
-d "{\"phone\":\"918600137050\",\"templateName\":\"welcome_template\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\",\"Doe\"]}"
```

---

## Success Response

```json
{
  "success": true,
  "msg": "Template sent successfully",
  "waMessageId": "wamid.HBgMOTE4NjAwMTM3MDUwFQIAEhggQUNCRTc1QzdBMjEwNkFDMjMyRTE0MzZDN0EwN0I5NjEA",
  "data": {
    "id": 15,
    "contactId": 3,
    "userId": 1,
    "direction": "outgoing",
    "message": "Template: hello_world",
    "type": "text",
    "status": "sent",
    "waMessageId": "wamid.HBgMOTE4NjAwMTM3MDUwFQIAEhggQUNCRTc1QzdBMjEwNkFDMjMyRTE0MzZDN0EwN0I5NjEA",
    "timestamp": "2026-01-12T13:40:10.000Z"
  }
}
```

---

## Complete Example

### 1. Login to Get Token
```cmd
curl -X POST http://localhost:5000/api/auth/login ^
-H "Content-Type: application/json" ^
-d "{\"email\":\"your_email@example.com\",\"password\":\"your_password\"}"
```

**Copy the `token` from response**

### 2. Send Template
```cmd
curl -X POST http://localhost:5000/api/messages/send-template ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." ^
-d "{\"phone\":\"918600137050\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

---

## Template Parameters

If your template has variables (like `{{1}}`, `{{2}}`), include them in `templateParams`:

**Template Text:** `"Hello {{1}}, your order {{2}} is ready!"`

**Request:**
```json
{
  "phone": "918600137050",
  "templateName": "order_ready",
  "templateLanguage": "en_US",
  "templateParams": ["John", "#12345"]
}
```

**Result:** User receives: "Hello John, your order #12345 is ready!"

---

## Common Errors

### Error: Template Not Found
```json
{
  "success": false,
  "msg": "Template send failed: Template not found"
}
```
**Solution:** Check template name is correct and approved

### Error: Template Not Approved
```json
{
  "success": false,
  "msg": "Template send failed: Template status is PENDING"
}
```
**Solution:** Wait for Meta approval or use an approved template

### Error: Contact Not Found
```json
{
  "success": false,
  "msg": "Contact not found"
}
```
**Solution:** Contact is created automatically, but check phone number format

---

## Quick Reference

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `phone` | ✅ Yes | Recipient phone number | `"918600137050"` |
| `templateName` | ✅ Yes | Template name from Meta | `"hello_world"` |
| `templateLanguage` | ❌ No | Language code (default: en_US) | `"en_US"` |
| `templateParams` | ❌ No | Array of parameter values | `["John", "Doe"]` |

---

## What Happens After Sending?

1. ✅ Template sent via Meta API
2. ✅ Message saved to database
3. ✅ Contact created/updated
4. ✅ `lastContacted` timestamp updated
5. ✅ User receives template message
6. ✅ **24-hour window opens** - User can now reply
7. ✅ After user replies, you can use `/api/messages/send` normally

---

## Notes

- ✅ Works for **non-verified numbers** (opens 24-hour window)
- ✅ Works for **verified numbers** (no restrictions)
- ✅ Contact is **created automatically** if doesn't exist
- ✅ Template must be **APPROVED** by Meta
- ✅ Use exact template name as shown in Meta dashboard

