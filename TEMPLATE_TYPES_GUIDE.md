# WhatsApp Template Types Guide

Meta WhatsApp Business API supports various template components beyond just text. This guide shows how to create different template types.

---

## 📋 Template Structure

A template can have:
- **HEADER** (optional): Text, Image, Video, or Document
- **BODY** (required): Text with optional variables `{{1}}`, `{{2}}`, etc.
- **FOOTER** (optional): Plain text only
- **BUTTONS** (optional): Quick Reply, URL, or Phone Number buttons

---

## 🎯 Template Type Examples

### 1️⃣ Text-Only Template (Simple)

```json
{
  "name": "hello_world",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello! Welcome to our service."
    }
  ]
}
```

---

### 2️⃣ Text with Variables

```json
{
  "name": "welcome_user",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to {{2}}! Your order {{3}} is ready."
    }
  ]
}
```

**When sending, provide parameters:**
```json
{
  "phone": "919822426339",
  "templateName": "welcome_user",
  "templateLanguage": "en_US",
  "templateParams": ["John", "Our Store", "ORD123"]
}
```

---

### 3️⃣ Template with Header (Text)

```json
{
  "name": "order_confirmation",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Order Confirmation"
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}, your order {{2}} has been confirmed. Total: ${{3}}"
    },
    {
      "type": "FOOTER",
      "text": "Thank you for shopping with us!"
    }
  ]
}
```

---

### 4️⃣ Template with Header (Image)

```json
{
  "name": "promo_with_image",
  "category": "MARKETING",
  "language": "en_US",
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
      "text": "Check out our amazing {{1}} offer! Get {{2}}% off today."
    },
    {
      "type": "FOOTER",
      "text": "Limited time offer"
    }
  ]
}
```

**Note:** For images, you need to upload the image first using Media API and get the `handle`.

---

### 5️⃣ Template with Header (Video)

```json
{
  "name": "product_video",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "VIDEO",
      "example": {
        "header_handle": ["YOUR_VIDEO_HANDLE"]
      }
    },
    {
      "type": "BODY",
      "text": "Watch our new product video! {{1}} is now available."
    }
  ]
}
```

---

### 6️⃣ Template with Header (Document)

```json
{
  "name": "invoice_template",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "DOCUMENT",
      "example": {
        "header_handle": ["YOUR_DOCUMENT_HANDLE"]
      }
    },
    {
      "type": "BODY",
      "text": "Your invoice {{1}} is ready. Download it from the header."
    }
  ]
}
```

---

### 7️⃣ Template with Quick Reply Buttons

```json
{
  "name": "customer_support",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "How can we help you today?"
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
          "type": "QUICK_REPLY",
          "text": "View Catalog"
        }
      ]
    }
  ]
}
```

**Rules:**
- Maximum 3 quick reply buttons
- Button text: 1-20 characters
- No emojis in button text

---

### 8️⃣ Template with URL Button

```json
{
  "name": "product_link",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Check out our new product {{1}}!"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "View Product",
          "url": "https://example.com/product/{{1}}",
          "example": ["12345"]
        }
      ]
    }
  ]
}
```

**Rules:**
- URL can contain variables like `{{1}}`
- Provide example values in `example` array
- Maximum 1 URL button per template

---

### 9️⃣ Template with Phone Number Button

```json
{
  "name": "call_us",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Need help? Call us directly!"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "PHONE_NUMBER",
          "text": "Call Support",
          "phone_number": "+1234567890"
        }
      ]
    }
  ]
}
```

**Rules:**
- Phone number must include country code (e.g., +1234567890)
- Maximum 1 phone number button per template

---

### 🔟 Complete Template (All Components)

```json
{
  "name": "complete_promo",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": ["IMAGE_HANDLE_123"]
      }
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}! Get {{2}}% off on {{3}}. Use code: {{4}}"
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
          "url": "https://example.com/shop?code={{4}}",
          "example": ["CODE123"]
        },
        {
          "type": "QUICK_REPLY",
          "text": "More Info"
        }
      ]
    }
  ]
}
```

---

## 📤 How to Create Templates via API

### Endpoint:
```
POST /api/templates/create
```

### Headers:
```
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
```

### Example Request (Text with Buttons):

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"customer_support\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"How can we help you today?\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Track Order\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Speak to Agent\"}]}]}"
```

---

## 📝 Component Types Reference

### HEADER Formats:
- `TEXT` - Plain text header
- `IMAGE` - Image header (requires handle)
- `VIDEO` - Video header (requires handle)
- `DOCUMENT` - Document header (requires handle)

### BUTTON Types:
- `QUICK_REPLY` - User taps to send predefined text
- `URL` - Opens a website (can have variables)
- `PHONE_NUMBER` - Initiates a phone call

### Categories:
- `UTILITY` - Transactional messages (orders, updates)
- `MARKETING` - Promotional messages (offers, sales)
- `AUTHENTICATION` - OTP, verification codes

---

## ⚠️ Important Rules

1. **BODY is required** - Every template must have a BODY component
2. **Variable limits:**
   - BODY: Maximum 1024 characters
   - Maximum 10 variables per template
   - Variable format: `{{1}}`, `{{2}}`, etc.
3. **Button limits:**
   - Maximum 3 buttons total
   - Maximum 1 URL button
   - Maximum 1 Phone Number button
   - Quick Reply buttons: 1-20 characters
4. **Header limits:**
   - TEXT: Maximum 60 characters
   - Media headers require upload first
5. **Footer:**
   - Maximum 60 characters
   - Plain text only (no variables)

---

## 🎨 Template Examples by Use Case

### Order Confirmation
```json
{
  "name": "order_confirm",
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
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Track Order",
          "url": "https://example.com/track/{{1}}",
          "example": ["ORD123"]
        }
      ]
    }
  ]
}
```

### Promotional Offer
```json
{
  "name": "flash_sale",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": ["SALE_IMAGE_HANDLE"]
      }
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}! Flash sale: {{2}}% off on all {{3}}. Use code: {{4}}"
    },
    {
      "type": "FOOTER",
      "text": "Valid for 24 hours only"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Shop Now",
          "url": "https://example.com/sale?code={{4}}",
          "example": ["FLASH50"]
        },
        {
          "type": "QUICK_REPLY",
          "text": "View Catalog"
        }
      ]
    }
  ]
}
```

---

## ✅ Next Steps

1. **Create template** using `/api/templates/create`
2. **Wait for approval** (24-48 hours from Meta)
3. **Check status** using `/api/templates/meta`
4. **Send template** using `/api/messages/send-template` (once APPROVED)

---

## 🔗 Related Endpoints

- `POST /api/templates/create` - Create new template
- `GET /api/templates/meta` - Fetch all templates and status
- `POST /api/messages/send-template` - Send approved template

