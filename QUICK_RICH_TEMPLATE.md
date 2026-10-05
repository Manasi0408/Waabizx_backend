# Quick Rich Template - Copy & Paste Ready

## 🎯 Working Example (TEXT Header - No Upload Needed)

### Template: `welcome_rich` with Text Header + Buttons

**✅ Use this version (works immediately):**

```json
{
  "name": "welcome_rich",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Welcome!"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service! Click below to start."
    },
    {
      "type": "FOOTER",
      "text": "We're here to help 24/7"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Start Chat"
        },
        {
          "type": "URL",
          "text": "Visit Website",
          "url": "https://yourwebsite.com",
          "example": []
        }
      ]
    }
  ]
}
```

**⚠️ For IMAGE header:** You need to upload media first and get a real handle. See `MEDIA_UPLOAD_GUIDE.md`

---

## 📤 Create This Template

### Option 1: Using CURL (Windows CMD) - TEXT Header (Works Now!)

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_rich\",\"language\":\"en_US\",\"category\":\"MARKETING\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Welcome!\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service! Click below to start.\"},{\"type\":\"FOOTER\",\"text\":\"We're here to help 24/7\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Start Chat\"},{\"type\":\"URL\",\"text\":\"Visit Website\",\"url\":\"https://yourwebsite.com\",\"example\":[]}]}]}"
```

**⚠️ Note:** For IMAGE header, you need to upload media first. Use TEXT header for now.

### Option 2: Using JSON File

1. **Create `welcome_rich.json`:**
```json
{
  "name": "welcome_rich",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": ["YOUR_IMAGE_HANDLE"]
      }
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service! Click below to start."
    },
    {
      "type": "FOOTER",
      "text": "We're here to help 24/7"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Start Chat"
        },
        {
          "type": "URL",
          "text": "Visit Website",
          "url": "https://yourwebsite.com",
          "example": []
        }
      ]
    }
  ]
}
```

2. **Send it:**
```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d @welcome_rich.json
```

---

## 🔄 Alternative: Text Header (No Image Upload Needed)

If you don't have an image handle yet, use TEXT header:

```json
{
  "name": "welcome_rich_text",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Welcome!"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service! Click below to start."
    },
    {
      "type": "FOOTER",
      "text": "We're here to help 24/7"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Start Chat"
        },
        {
          "type": "URL",
          "text": "Visit Website",
          "url": "https://yourwebsite.com",
          "example": []
        }
      ]
    }
  ]
}
```

---

## ✅ After Creation

1. **Wait for approval** (24-48 hours)
2. **Check status:**
```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

3. **Send once APPROVED:**
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"welcome_rich\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\"]}"
```

---

## 📝 Notes

- **TEXT Header:** Works immediately, no upload needed ✅
- **IMAGE Header:** Requires media upload first (see `MEDIA_UPLOAD_GUIDE.md`)
- **Variables:** `{{1}}` in BODY will be replaced with first parameter
- **Buttons:** 
  - Quick Reply sends predefined text
  - URL opens website
- **Footer:** Optional, max 60 characters
- **Remove:** Don't include `"example"` in BODY component (not needed)

---

## 🎨 More Examples

See `RICH_TEMPLATE_GUIDE.md` for:
- Video headers
- Document headers
- Phone number buttons
- Multiple button combinations
- More complex templates

