# Rich WhatsApp Templates Guide

Create templates with images, videos, buttons, and interactive elements.

---

## 🎨 Rich Template Structure

A rich template can include:
- **HEADER** - Image, Video, Document, or Text
- **BODY** - Text with variables `{{1}}`, `{{2}}`, etc.
- **FOOTER** - Optional text
- **BUTTONS** - Quick Reply, URL, or Phone Number buttons

---

## 📋 Example: Rich Template with Image + Buttons

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

---

## 🖼️ Step 1: Upload Media for Header

Before creating a template with IMAGE/VIDEO/DOCUMENT header, you need to upload the media to Meta and get a handle.

### Upload Image/Video/Document

**Note:** You need to upload media through Meta's Media API first. The handle is returned after upload.

For now, you can:
1. Use Meta Business Manager UI to upload media
2. Or use the Media API endpoint (we'll add this later)

**Temporary workaround:** Use TEXT header instead of IMAGE until media upload is implemented.

---

## 📤 Step 2: Create Rich Template via API

### Example 1: Rich Template with Image Header + Buttons

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_rich\",\"category\":\"MARKETING\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"IMAGE\",\"example\":{\"header_handle\":[\"YOUR_IMAGE_HANDLE\"]}},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service! Click below to start.\"},{\"type\":\"FOOTER\",\"text\":\"We're here to help 24/7\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Start Chat\"},{\"type\":\"URL\",\"text\":\"Visit Website\",\"url\":\"https://yourwebsite.com\",\"example\":[]}]}]}"
```

### Example 2: Rich Template with Text Header + Multiple Buttons

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"product_promo\",\"category\":\"MARKETING\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Special Offer Today!\"},{\"type\":\"BODY\",\"text\":\"Hi {{1}}, get {{2}}% off on {{3}}. Use code: {{4}}\"},{\"type\":\"FOOTER\",\"text\":\"Limited time only\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"URL\",\"text\":\"Shop Now\",\"url\":\"https://yourwebsite.com/shop?code={{4}}\",\"example\":[\"CODE123\"]},{\"type\":\"QUICK_REPLY\",\"text\":\"More Info\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Contact Us\"}]}]}"
```

### Example 3: Rich Template with Video Header

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"product_video\",\"category\":\"MARKETING\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"VIDEO\",\"example\":{\"header_handle\":[\"YOUR_VIDEO_HANDLE\"]}},{\"type\":\"BODY\",\"text\":\"Watch our new product {{1}} in action!\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"URL\",\"text\":\"Buy Now\",\"url\":\"https://yourwebsite.com/product/{{1}}\",\"example\":[\"PROD123\"]}]}]}"
```

---

## 🎯 Button Types Explained

### 1. Quick Reply Button
User taps → sends predefined text message

```json
{
  "type": "QUICK_REPLY",
  "text": "Start Chat"
}
```

**Rules:**
- Text: 1-20 characters
- No emojis
- Maximum 3 quick reply buttons per template

### 2. URL Button
User taps → opens website

```json
{
  "type": "URL",
  "text": "Visit Website",
  "url": "https://yourwebsite.com",
  "example": []
}
```

**With variable:**
```json
{
  "type": "URL",
  "text": "View Product",
  "url": "https://yourwebsite.com/product/{{1}}",
  "example": ["12345"]
}
```

**Rules:**
- Maximum 1 URL button per template
- URL can contain variables
- Provide example values in `example` array

### 3. Phone Number Button
User taps → initiates phone call

```json
{
  "type": "PHONE_NUMBER",
  "text": "Call Support",
  "phone_number": "+1234567890"
}
```

**Rules:**
- Maximum 1 phone button per template
- Phone must include country code (+1234567890)

---

## 📝 Complete Rich Template Examples

### Example A: E-commerce Product Promotion

```json
{
  "name": "product_promo_rich",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": ["PRODUCT_IMAGE_HANDLE"]
      }
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}! Check out our new {{2}}. Get {{3}}% off with code {{4}}."
    },
    {
      "type": "FOOTER",
      "text": "Valid until {{5}}"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Shop Now",
          "url": "https://yourstore.com/product/{{2}}?code={{4}}",
          "example": ["PROD123", "CODE50"]
        },
        {
          "type": "QUICK_REPLY",
          "text": "View Catalog"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Contact Sales"
        }
      ]
    }
  ]
}
```

### Example B: Customer Support Template

```json
{
  "name": "support_rich",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "How can we help?"
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}, we're here to assist you with your {{2}}."
    },
    {
      "type": "FOOTER",
      "text": "Available 24/7"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Track Order"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Speak to Agent"
        },
        {
          "type": "PHONE_NUMBER",
          "text": "Call Us",
          "phone_number": "+1234567890"
        }
      ]
    }
  ]
}
```

### Example C: Order Confirmation with Tracking

```json
{
  "name": "order_track_rich",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Order #{{1}}"
    },
    {
      "type": "BODY",
      "text": "Hi {{2}}, your order has been confirmed! Total: ${{3}}. Expected delivery: {{4}}"
    },
    {
      "type": "FOOTER",
      "text": "Thank you for shopping with us"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Track Order",
          "url": "https://yourstore.com/track/{{1}}",
          "example": ["ORD123"]
        },
        {
          "type": "QUICK_REPLY",
          "text": "Contact Support"
        }
      ]
    }
  ]
}
```

---

## 🚀 How to Send Rich Templates

Once your template is **APPROVED**, send it like this:

### Simple (No Variables):
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"welcome_rich\",\"templateLanguage\":\"en_US\"}"
```

### With Variables:
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"product_promo_rich\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\",\"Product Name\",\"20\",\"CODE20\",\"2024-12-31\"]}"
```

---

## ⚠️ Important Notes

### Media Headers (IMAGE/VIDEO/DOCUMENT):
1. **Upload media first** to Meta Media API
2. **Get handle** from upload response
3. **Use handle** in template `header_handle` field
4. **Example format:**
   ```json
   {
     "type": "HEADER",
     "format": "IMAGE",
     "example": {
       "header_handle": ["abc123xyz"]
     }
   }
   ```

### Button Limits:
- **Maximum 3 buttons** total
- **Maximum 1 URL button**
- **Maximum 1 Phone Number button**
- **Quick Reply buttons:** 1-20 characters, no emojis

### Variable Rules:
- Use `{{1}}`, `{{2}}`, etc. in BODY text
- Use `{{1}}` in URL buttons
- Provide example values in button `example` array
- Maximum 10 variables per template

---

## ✅ Template Creation Checklist

- [ ] Choose template name (lowercase, underscores)
- [ ] Select category (MARKETING/UTILITY/AUTHENTICATION)
- [ ] Add HEADER (optional: TEXT/IMAGE/VIDEO/DOCUMENT)
- [ ] Add BODY (required, with variables if needed)
- [ ] Add FOOTER (optional, max 60 chars)
- [ ] Add BUTTONS (optional, max 3)
- [ ] Upload media if using IMAGE/VIDEO/DOCUMENT header
- [ ] Submit via `/api/templates/create`
- [ ] Wait for approval (24-48 hours)
- [ ] Check status via `/api/templates/meta`
- [ ] Send once APPROVED

---

## 📚 Related Files

- `TEMPLATE_TYPES_GUIDE.md` - Complete component reference
- `CREATE_TEMPLATE_EXAMPLES.md` - More examples
- `TEMPLATE_EXAMPLES.json` - JSON examples file

