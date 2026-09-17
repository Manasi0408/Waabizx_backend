# Rich Template CURL Command - High Approval Rate

## ✅ Rich Template with UTILITY Category (Recommended)

This template includes:
- ✅ TEXT Header
- ✅ BODY with variable
- ✅ FOOTER
- ✅ Multiple QUICK_REPLY buttons
- ✅ UTILITY category (higher approval rate)

### Windows CMD:

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzY2MTQ2MDc2LCJleHAiOjE3Njg3MzgwNzZ9.qSGw4hSsByGLula8rjSv0h0YpVebjZSKmnGEKQHrV2M" ^
  -d "{\"name\":\"account_notification\",\"language\":\"en_US\",\"category\":\"UTILITY\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Account Update\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, your account has been updated successfully. Your reference number is {{2}}. How can we assist you?\"},{\"type\":\"FOOTER\",\"text\":\"Thank you for using our service\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"View Details\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Get Help\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Contact Us\"}]}]}"
```

---

## ✅ Rich Template with TEXT Header + BODY + FOOTER + 2 Buttons

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzY2MTQ2MDc2LCJleHAiOjE3Njg3MzgwNzZ9.qSGw4hSsByGLula8rjSv0h0YpVebjZSKmnGEKQHrV2M" ^
  -d "{\"name\":\"service_notification\",\"language\":\"en_US\",\"category\":\"UTILITY\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Service Notification\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, your service request {{2}} has been processed. We will contact you soon.\"},{\"type\":\"FOOTER\",\"text\":\"We are here to help\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Confirm\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Need Help\"}]}]}"
```

---

## ✅ Rich Template - Order/Transaction Style

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzY2MTQ2MDc2LCJleHAiOjE3Njg3MzgwNzZ9.qSGw4hSsByGLula8rjSv0h0YpVebjZSKmnGEKQHrV2M" ^
  -d "{\"name\":\"order_confirmation\",\"language\":\"en_US\",\"category\":\"UTILITY\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Order Confirmation\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, your order {{2}} has been confirmed. Total amount: {{3}}. Expected delivery: {{4}}.\"},{\"type\":\"FOOTER\",\"text\":\"Track your order anytime\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Track Order\"},{\"type\":\"QUICK_REPLY\",\"text\":\"View Details\"}]}]}"
```

---

## 🎯 Why These Templates Get Approved

1. **UTILITY Category** - Easier approval than MARKETING
2. **TEXT Header** - No media upload issues
3. **QUICK_REPLY Buttons** - No URL accessibility checks
4. **Clear Purpose** - Transactional/utility messages
5. **Proper Structure** - All components properly formatted

---

## 📋 Template Structure

```json
{
  "name": "template_name",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Header Text"
    },
    {
      "type": "BODY",
      "text": "Body text with {{1}} variable"
    },
    {
      "type": "FOOTER",
      "text": "Footer text"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Button 1"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Button 2"
        }
      ]
    }
  ]
}
```

---

## ⚠️ Important Notes

1. **Replace JWT Token** - Use your actual JWT token
2. **Template Name** - Must be unique (change if already exists)
3. **Variables** - Use {{1}}, {{2}}, etc. in BODY text
4. **Button Text** - 1-20 characters, no emojis
5. **Category** - UTILITY for transactional, MARKETING for promotional

---

## 🚀 Quick Copy-Paste (Replace YOUR_JWT_TOKEN)

```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"account_notification\",\"language\":\"en_US\",\"category\":\"UTILITY\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Account Update\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, your account has been updated successfully. Your reference number is {{2}}. How can we assist you?\"},{\"type\":\"FOOTER\",\"text\":\"Thank you for using our service\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"View Details\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Get Help\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Contact Us\"}]}]}"
```

---

## ✅ Expected Response

```json
{
  "success": true,
  "message": "Template submitted to Meta for approval",
  "metaTemplateId": "123456789",
  "status": "PENDING",
  "template": {
    "id": 7,
    "name": "account_notification",
    "status": "draft",
    ...
  }
}
```

**Status will be PENDING initially. Check after 24-48 hours via `/api/templates/meta`**

