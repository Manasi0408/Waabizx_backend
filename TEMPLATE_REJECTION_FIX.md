# Fix Template Rejection Issues

## ❌ Common Reasons Meta Rejects Templates

1. **URL Button Issues:**
   - URL must be accessible and valid
   - `example` array format incorrect
   - URL contains invalid characters

2. **Button Text Issues:**
   - Text too long (max 20 characters)
   - Contains emojis (not allowed)
   - Text violates policies

3. **Footer Issues:**
   - Too long (max 60 characters)
   - Contains promotional content in UTILITY category

4. **Header Issues:**
   - Too long (max 60 characters for TEXT)
   - Contains special characters

5. **Policy Violations:**
   - Misleading content
   - Spam-like language
   - Unclear call-to-action

---

## ✅ Fixed Template (Should Get Approved)

### Issue in Your Template:
- URL button `example: []` might need proper format
- URL might need to be a real, accessible website
- Button text might need adjustment

### Fixed Version 1: Remove URL Button (Simpler)

```json
{
  "name": "welcome_rich_simple",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Welcome"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service! Click below to start."
    },
    {
      "type": "FOOTER",
      "text": "We are here to help"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Start Chat"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Get Help"
        }
      ]
    }
  ]
}
```

**CURL:**
```bash
curl -X POST "http://localhost:5000/api/templates/create" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_rich_simple\",\"language\":\"en_US\",\"category\":\"MARKETING\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Welcome\"},{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service! Click below to start.\"},{\"type\":\"FOOTER\",\"text\":\"We are here to help\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Start Chat\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Get Help\"}]}]}"
```

---

### Fixed Version 2: URL Button with Proper Format

```json
{
  "name": "welcome_rich_url",
  "language": "en_US",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Welcome"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service!"
    },
    {
      "type": "FOOTER",
      "text": "Visit our website"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "Visit Website",
          "url": "https://www.example.com",
          "example": []
        }
      ]
    }
  ]
}
```

**Important:** 
- Use a **real, accessible URL** (not `yourwebsite.com`)
- URL must use HTTPS
- URL must be publicly accessible
- `example: []` is correct for URLs without variables

---

### Fixed Version 3: UTILITY Category (More Likely to Approve)

```json
{
  "name": "welcome_utility",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Account Update"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, your account has been set up successfully."
    },
    {
      "type": "FOOTER",
      "text": "Thank you"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Get Started"
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

**UTILITY category** is easier to get approved than MARKETING.

---

## 🔍 How to Check Rejection Reason

Meta doesn't always provide detailed rejection reasons, but you can:

1. **Check Meta Business Manager:**
   - Go to WhatsApp Manager
   - Click Message Templates
   - Find your template
   - Check rejection reason (if provided)

2. **Common Issues to Fix:**
   - ✅ Use real, accessible URLs
   - ✅ Keep button text under 20 characters
   - ✅ No emojis in buttons
   - ✅ Footer under 60 characters
   - ✅ Header under 60 characters
   - ✅ Clear, non-misleading content
   - ✅ Use UTILITY category for transactional messages

---

## ✅ Best Practices for Approval

1. **Use UTILITY category** for transactional messages (easier approval)
2. **Use real URLs** that are publicly accessible
3. **Keep text simple** and clear
4. **Avoid promotional language** in UTILITY templates
5. **Test URL accessibility** before submitting
6. **Use QUICK_REPLY buttons** instead of URL when possible (easier approval)

---

## 🎯 Recommended Template (High Approval Rate)

```json
{
  "name": "welcome_safe",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, your account is ready. How can we help you?"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Get Started"
        },
        {
          "type": "QUICK_REPLY",
          "text": "Need Help"
        }
      ]
    }
  ]
}
```

**Why this works:**
- ✅ UTILITY category (easier approval)
- ✅ No header (simpler)
- ✅ No footer (simpler)
- ✅ Only QUICK_REPLY buttons (no URL issues)
- ✅ Clear, simple text
- ✅ No promotional language

---

## 📝 Next Steps

1. **Try the simple version** (QUICK_REPLY only, no URL)
2. **Use UTILITY category** if it's transactional
3. **Check Meta Business Manager** for rejection reason
4. **Resubmit with fixes** after 24 hours

---

## ⚠️ Important Notes

- **Rejection is normal** - Meta is strict
- **Resubmit after fixing** - Wait 24 hours between submissions
- **Check Business Manager** - Sometimes they provide rejection reasons
- **Start simple** - Add complexity after first approval

