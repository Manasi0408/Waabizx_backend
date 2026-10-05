# Create Template Examples - Ready to Use

## 🚀 Quick Start

Copy any example below and use it with:
```
POST /api/templates/create
```

---

## Example 1: Simple Text Template

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"hello_world\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Hello! Welcome to our service.\"}]}"
```

---

## Example 2: Text with Variables

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"welcome_user\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to {{2}}! Your order {{3}} is ready.\"}]}"
```

**When sending, use:**
```json
{
  "phone": "919822426339",
  "templateName": "welcome_user",
  "templateLanguage": "en_US",
  "templateParams": ["John", "Our Store", "ORD123"]
}
```

---

## Example 3: Template with Header and Footer

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"order_confirmation\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Order Confirmation\"},{\"type\":\"BODY\",\"text\":\"Hi {{1}}, your order {{2}} has been confirmed. Total: ${{3}}\"},{\"type\":\"FOOTER\",\"text\":\"Thank you for shopping with us!\"}]}"
```

---

## Example 4: Template with Quick Reply Buttons

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"customer_support\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"How can we help you today?\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"QUICK_REPLY\",\"text\":\"Track Order\"},{\"type\":\"QUICK_REPLY\",\"text\":\"Speak to Agent\"},{\"type\":\"QUICK_REPLY\",\"text\":\"View Catalog\"}]}]}"
```

---

## Example 5: Template with URL Button

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"product_link\",\"category\":\"MARKETING\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Check out our new product {{1}}!\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"URL\",\"text\":\"View Product\",\"url\":\"https://example.com/product/{{1}}\",\"example\":[\"12345\"]}]}]}"
```

---

## Example 6: Template with Phone Button

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"call_us\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Need help? Call us directly!\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"PHONE_NUMBER\",\"text\":\"Call Support\",\"phone_number\":\"+1234567890\"}]}]}"
```

---

## Example 7: Complete Template (All Features)

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"complete_promo\",\"category\":\"MARKETING\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Special Offer\"},{\"type\":\"BODY\",\"text\":\"Hi {{1}}! Get {{2}}% off on {{3}}. Use code: {{4}}\"},{\"type\":\"FOOTER\",\"text\":\"Valid until {{5}}\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"URL\",\"text\":\"Shop Now\",\"url\":\"https://example.com/shop?code={{4}}\",\"example\":[\"CODE123\"]},{\"type\":\"QUICK_REPLY\",\"text\":\"More Info\"}]}]}"
```

---

## Example 8: Order Tracking Template

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"order_tracking\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"HEADER\",\"format\":\"TEXT\",\"text\":\"Order #{{1}}\"},{\"type\":\"BODY\",\"text\":\"Hi {{2}}, your order has been confirmed! Total: ${{3}}. Expected delivery: {{4}}\"},{\"type\":\"BUTTONS\",\"buttons\":[{\"type\":\"URL\",\"text\":\"Track Order\",\"url\":\"https://example.com/track/{{1}}\",\"example\":[\"ORD123\"]},{\"type\":\"QUICK_REPLY\",\"text\":\"Contact Support\"}]}]}"
```

---

## Example 9: OTP Verification Template

```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"otp_verification\",\"category\":\"AUTHENTICATION\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Your OTP code is {{1}}. Valid for {{2}} minutes. Do not share this code with anyone.\"},{\"type\":\"FOOTER\",\"text\":\"This is an automated message\"}]}"
```

---

## 📝 Using JSON Files (Easier for Complex Templates)

### Step 1: Create `template.json`:
```json
{
  "name": "my_template",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome!"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "QUICK_REPLY",
          "text": "Get Started"
        }
      ]
    }
  ]
}
```

### Step 2: Send it:
```bash
curl -X POST http://localhost:5000/api/templates/create ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d @template.json
```

---

## ✅ Template Components Summary

| Component | Type | Required | Description |
|-----------|------|----------|-------------|
| **HEADER** | TEXT/IMAGE/VIDEO/DOCUMENT | No | Top section of template |
| **BODY** | TEXT | **Yes** | Main message with variables |
| **FOOTER** | TEXT | No | Bottom text (max 60 chars) |
| **BUTTONS** | QUICK_REPLY/URL/PHONE | No | Interactive buttons (max 3) |

---

## 🎯 Template Categories

- **UTILITY** - Transactional (orders, updates, confirmations)
- **MARKETING** - Promotional (offers, sales, announcements)
- **AUTHENTICATION** - OTP, verification codes

---

## ⚠️ Important Notes

1. **Template name** must be unique and lowercase with underscores (e.g., `hello_world`)
2. **BODY is required** - Every template must have a BODY component
3. **Variables** use format `{{1}}`, `{{2}}`, etc.
4. **Buttons** - Maximum 3 buttons, max 1 URL, max 1 Phone Number
5. **Approval** - Templates need Meta approval (24-48 hours)
6. **Status** - Check with `GET /api/templates/meta`

---

## 🔍 Check Template Status

After creating, check if it's approved:

```bash
curl -X GET http://localhost:5000/api/templates/meta ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Look for your template and check `status: "APPROVED"` before sending.

---

## 📤 Send Template (Once Approved)

```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

For templates with variables:
```bash
curl -X POST http://localhost:5000/api/messages/send-template ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"phone\":\"919822426339\",\"templateName\":\"welcome_user\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\",\"Our Store\",\"ORD123\"]}"
```

