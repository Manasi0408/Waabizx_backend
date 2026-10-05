# CURL Template Examples for Windows CMD

## ✅ Correct Format for Sending Templates

### Example 1: Template WITHOUT Parameters (Simple Template)

**Using your backend API:**
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

**Direct to Meta API (Windows CMD - CORRECT FORMAT):**
```bash
curl -X POST "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages" ^
  -H "Authorization: Bearer YOUR_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"messaging_product\":\"whatsapp\",\"to\":\"919822426339\",\"type\":\"template\",\"template\":{\"name\":\"hello_world\",\"language\":{\"code\":\"en_US\"}}}"
```

**Important:** Do NOT include `components` if the template doesn't have parameters!

---

### Example 2: Template WITH Parameters

**Using your backend API:**
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"welcome_template\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\",\"Doe\"]}"
```

**Direct to Meta API (Windows CMD - WITH PARAMETERS):**
```bash
curl -X POST "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages" ^
  -H "Authorization: Bearer YOUR_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"messaging_product\":\"whatsapp\",\"to\":\"919822426339\",\"type\":\"template\",\"template\":{\"name\":\"welcome_template\",\"language\":{\"code\":\"en_US\"},\"components\":[{\"type\":\"BODY\",\"parameters\":[{\"type\":\"text\",\"text\":\"John\"},{\"type\":\"text\",\"text\":\"Doe\"}]}]}}"
```

---

## ❌ Common Errors

### Error 1: "messaging_product is required"
**Cause:** JSON formatting issue in Windows CMD
**Solution:** Use proper escaping or use a JSON file

**Better approach - Use a JSON file:**
1. Create `template.json`:
```json
{
  "messaging_product": "whatsapp",
  "to": "919822426339",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": {
      "code": "en_US"
    }
  }
}
```

2. Use the file:
```bash
curl -X POST "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages" ^
  -H "Authorization: Bearer YOUR_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d @template.json
```

---

### Error 2: "Template name does not exist"
**Cause:** Template name is wrong or template is not approved
**Solution:** 
1. Fetch available templates:
```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

2. Use an APPROVED template name

---

### Error 3: "components" causing issues
**Cause:** Including `components` when template doesn't need parameters
**Solution:** Only include `components` if the template has variables like `{{1}}`, `{{2}}`, etc.

**Template WITHOUT variables:**
```json
{
  "messaging_product": "whatsapp",
  "to": "919822426339",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": { "code": "en_US" }
  }
}
```

**Template WITH variables:**
```json
{
  "messaging_product": "whatsapp",
  "to": "919822426339",
  "type": "template",
  "template": {
    "name": "welcome_template",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "BODY",
        "parameters": [
          { "type": "text", "text": "John" }
        ]
      }
    ]
  }
}
```

---

## 🔧 Using PowerShell (Alternative to CMD)

PowerShell handles JSON better:

```powershell
$body = @{
    messaging_product = "whatsapp"
    to = "919822426339"
    type = "template"
    template = @{
        name = "hello_world"
        language = @{
            code = "en_US"
        }
    }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages" `
  -Method Post `
  -Headers @{
    "Authorization" = "Bearer YOUR_TOKEN"
    "Content-Type" = "application/json"
  } `
  -Body $body
```

---

## ✅ Recommended: Use Your Backend API

Instead of calling Meta API directly, use your backend which handles everything:

```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

**Benefits:**
- ✅ Handles JSON formatting correctly
- ✅ Saves message to database
- ✅ Creates contact if needed
- ✅ Emits socket events
- ✅ Better error handling

---

## 📝 Quick Reference

**Your Backend Endpoint:**
- `POST /api/messages/send-template`
- Requires: JWT token in `Authorization` header
- Body: `{ "phone": "...", "templateName": "...", "templateLanguage": "en_US", "templateParams": [...] }`

**Meta API Direct:**
- `POST https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages`
- Requires: Bearer token in `Authorization` header
- Body: Full template payload (see examples above)

