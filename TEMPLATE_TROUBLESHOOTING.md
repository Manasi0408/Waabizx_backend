# Template Troubleshooting Guide

## Problem: Template name does not exist

If you get this error:
```json
{
  "error": {
    "message": "(#132001) Template name does not exist in the translation",
    "code": 132001
  }
}
```

This means the template name you're using doesn't exist in your Meta WhatsApp Business account.

---

## ✅ Solution 1: Fetch Available Templates

First, check what templates are available in your Meta account:

### Step 1: Get JWT Token
```bash
curl -X POST http://localhost:5000/api/users/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"your_email@example.com\",\"password\":\"your_password\"}"
```

Copy the `token` from the response.

### Step 2: Fetch Templates from Meta
```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

This will return all available templates with their:
- `name` (use this in your send-template request)
- `status` (APPROVED, PENDING, REJECTED)
- `category` (MARKETING, UTILITY, AUTHENTICATION)
- `language` (en_US, etc.)

### Step 3: Use an APPROVED Template

Look for templates with `"status": "APPROVED"` and use that template's `name`:

```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

**Note:** Replace `hello_world` with an actual APPROVED template name from Step 2.

---

## ✅ Solution 2: Create a New Template

If you don't have any templates or need a new one:

### Step 1: Create Template via Meta API

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_template\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service!\"}]}"
```

**Template Structure:**
```json
{
  "name": "welcome_template",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service!"
    }
  ]
}
```

**Categories:**
- `UTILITY` - Transactional messages (order updates, account info)
- `MARKETING` - Promotional messages (offers, announcements)
- `AUTHENTICATION` - OTP, verification codes

### Step 2: Wait for Approval

Templates need Meta approval (usually 24-48 hours). Status will be:
- `PENDING` - Waiting for approval
- `APPROVED` - Ready to use ✅
- `REJECTED` - Needs changes

### Step 3: Check Template Status

```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Look for your template and check if `status` is `APPROVED`.

### Step 4: Send Template (Once Approved)

```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"welcome_template\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\"]}"
```

**Note:** `templateParams` array maps to `{{1}}`, `{{2}}`, etc. in the template.

---

## 🔍 Common Issues

### Issue 1: Template Not Approved
**Error:** Template exists but status is `PENDING` or `REJECTED`
**Solution:** Wait for approval or fix rejected template

### Issue 2: Wrong Language Code
**Error:** Template exists but not in the language you specified
**Solution:** Check available languages for the template:
```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```
Look at the `language` field in the template response.

### Issue 3: Missing Template Parameters
**Error:** Template requires parameters but you didn't provide them
**Solution:** Check template structure and provide `templateParams`:
```json
{
  "templateParams": ["John", "Doe"]
}
```

---

## 📝 Quick Reference

### Environment Variables Needed:
- `WABA_ID` - For fetching templates (WhatsApp Business Account ID)
- `WHATSAPP_PHONE_NUMBER_ID` or `Phone_Number_ID` - For sending messages
- `WHATSAPP_TOKEN` or `Whatsapp_Token` - Your permanent access token

### Endpoints:
- `GET /api/templates/meta` - Fetch all templates from Meta
- `POST /api/templates/create` - Create new template (submits to Meta)
- `POST /api/messages/send-template` - Send template message

---

## 🎯 Example: Complete Flow

1. **Login:**
```bash
curl -X POST http://localhost:5000/api/users/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"admin@example.com\",\"password\":\"password123\"}"
```

2. **Fetch Templates:**
```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_TOKEN"
```

3. **Find APPROVED template** (e.g., `hello_world`)

4. **Send Template:**
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

---

## ✅ Success Response

```json
{
  "success": true,
  "msg": "Template sent successfully",
  "waMessageId": "wamid.HBgN..."
}
```

