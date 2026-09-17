# Media Upload Guide for Template Headers

## ⚠️ Problem: Invalid Media Handle

When you use `"YOUR_IMAGE_HANDLE"` as a placeholder, Meta API rejects it because it's not a real uploaded media handle.

---

## ✅ Solution 1: Use TEXT Header (No Upload Needed)

**Easiest option** - Use TEXT header instead of IMAGE:

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

**CURL Command:**
```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_rich\",\"language\":\"en_US\",\"category\":\"MARKETING\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Welcome!\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service! Click below to start.\"},{\"type\":\"FOOTER\",\"text\":\"We're here to help 24/7\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Start Chat\"},{\"type\":\"URL\",\"text\":\"Visit Website\",\"url\":\"https://yourwebsite.com\",\"example\":[]}]}]}"
```

---

## ✅ Solution 2: Upload Media First (For IMAGE/VIDEO/DOCUMENT Headers)

### Step 1: Upload Image to Meta Media API

```bash
curl -X POST "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/media" ^
  -H "Authorization: Bearer YOUR_WHATSAPP_TOKEN" ^
  -F "type=image" ^
  -F "messaging_product=whatsapp" ^
  -F "file=@/path/to/your/image.jpg"
```

**Response:**
```json
{
  "id": "1234567890123456"
}
```

This `id` is your **media handle**.

### Step 2: Use the Handle in Template

```json
{
  "type": "HEADER",
  "format": "IMAGE",
  "example": {
    "header_handle": ["1234567890123456"]
  }
}
```

---

## 📋 Complete Example: Template with Real Image Handle

```json
{
  "name": "welcome_rich_image",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": ["1234567890123456"]
      }
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service!"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Start Chat"
        }
      ]
    }
  ]
}
```

---

## 🎯 Quick Fix: Remove BODY example (Not Needed)

Also, remove the `"example"` from BODY component - it's not needed:

**❌ Wrong:**
```json
{
  "type": "BODY",
  "text": "Hello {{1}}, welcome!",
  "example": {
    "body_text": ["John"]
  }
}
```

**✅ Correct:**
```json
{
  "type": "BODY",
  "text": "Hello {{1}}, welcome!"
}
```

---

## 🔧 Working Template (TEXT Header - No Upload Needed)

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzY2MTQ2MDc2LCJleHAiOjE3Njg3MzgwNzZ9.qSGw4hSsByGLula8rjSv0h0YpVebjZSKmnGEKQHrV2M" ^
  -d "{\"name\":\"welcome_rich\",\"language\":\"en_US\",\"category\":\"MARKETING\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Welcome!\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service! Click below to start.\"},{\"type\":\"FOOTER\",\"text\":\"We're here to help 24/7\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Start Chat\"},{\"type\":\"URL\",\"text\":\"Visit Website\",\"url\":\"https://yourwebsite.com\",\"example\":[]}]}]}"
```

---

## 📝 Summary

1. **For now:** Use `"format": "TEXT"` header (no upload needed)
2. **Later:** Upload media first, get handle, then use in template
3. **Remove:** `"example"` from BODY component (not needed)

---

## 🚀 Next Steps

1. **Create template with TEXT header** (works immediately)
2. **Wait for approval** (24-48 hours)
3. **Send template** once approved
4. **Later:** Add image upload feature to your backend if needed

