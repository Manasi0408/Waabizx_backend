# Template Management API Guide

## Complete Template Workflow

### 1️⃣ Create Template (Submit to Meta for Approval)

**Endpoint:** `POST /api/templates/create`

**Description:** Submits a template to Meta WhatsApp API for approval. Template will be in PENDING status initially, then becomes APPROVED or REJECTED.

**Request:**
```json
{
  "name": "welcome_template",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service"
    }
  ]
}
```

**Categories:**
- `MARKETING` - Promotional messages
- `UTILITY` - Transactional messages
- `AUTHENTICATION` - OTP/Verification messages

**Response:**
```json
{
  "success": true,
  "message": "Template submitted to Meta for approval",
  "metaTemplateId": "123456789",
  "status": "PENDING",
  "template": {
    "id": 1,
    "name": "welcome_template",
    "status": "draft",
    ...
  }
}
```

**CURL Command:**
```cmd
curl -X POST http://localhost:5000/api/templates/create ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer YOUR_TOKEN" ^
-d "{\"name\":\"welcome_template\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome to our service\"}]}"
```

---

### 2️⃣ Get Templates from Meta (Shows Status)

**Endpoint:** `GET /api/templates/meta`

**Description:** Fetches all templates from Meta API and shows their approval status (APPROVED, REJECTED, PENDING). Also saves/updates templates in local database.

**Response:**
```json
{
  "success": true,
  "templates": [
    {
      "name": "welcome_template",
      "status": "APPROVED",
      "category": "UTILITY",
      "language": "en_US",
      "components": [...]
    },
    {
      "name": "promo_template",
      "status": "PENDING",
      "category": "MARKETING",
      ...
    },
    {
      "name": "rejected_template",
      "status": "REJECTED",
      "category": "MARKETING",
      ...
    }
  ],
  "statusSummary": {
    "approved": 5,
    "rejected": 1,
    "pending": 2,
    "total": 8
  },
  "saved": {
    "new": 2,
    "updated": 6,
    "errors": 0,
    "total": 8
  }
}
```

**CURL Command:**
```cmd
curl -X GET http://localhost:5000/api/templates/meta ^
-H "Authorization: Bearer YOUR_TOKEN"
```

---

### 3️⃣ Get Local Templates (from Database)

**Endpoint:** `GET /api/templates`

**Description:** Gets templates saved in your local database.

**Response:**
```json
{
  "success": true,
  "templates": [
    {
      "id": 1,
      "name": "welcome_template",
      "content": "Hello {{1}}, welcome to our service",
      "category": "transactional",
      "status": "approved",
      "userId": 1,
      ...
    }
  ],
  "pagination": {
    "total": 10,
    "page": 1,
    "pages": 1,
    "limit": 20
  }
}
```

**CURL Command:**
```cmd
curl -X GET http://localhost:5000/api/templates ^
-H "Authorization: Bearer YOUR_TOKEN"
```

---

## Status Mapping

### Meta API Status → Database Status

| Meta Status | Database Status | Description |
|------------|----------------|-------------|
| `APPROVED` | `approved` | Template approved, can be used |
| `REJECTED` | `rejected` | Template rejected by Meta |
| `PENDING` | `draft` | Waiting for Meta approval |

---

## Complete Workflow Example

### Step 1: Submit Template to Meta
```cmd
curl -X POST http://localhost:5000/api/templates/create ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer YOUR_TOKEN" ^
-d "{\"name\":\"welcome_template\",\"category\":\"UTILITY\",\"language\":\"en_US\",\"components\":[{\"type\":\"BODY\",\"text\":\"Hello {{1}}, welcome!\"}]}"
```

**Response:** `status: "PENDING"`

### Step 2: Wait for Meta Approval
- Meta reviews the template (usually takes a few minutes to hours)
- Status changes to `APPROVED` or `REJECTED`

### Step 3: Fetch Templates to Check Status
```cmd
curl -X GET http://localhost:5000/api/templates/meta ^
-H "Authorization: Bearer YOUR_TOKEN"
```

**Response:** Shows all templates with their current status:
- `APPROVED` - Ready to use
- `REJECTED` - Needs revision
- `PENDING` - Still under review

### Step 4: Use Approved Template
Once approved, use the template in `/api/messages/send-template`:
```cmd
curl -X POST http://localhost:5000/api/messages/send-template ^
-H "Content-Type: application/json" ^
-H "Authorization: Bearer YOUR_TOKEN" ^
-d "{\"phone\":\"918600137050\",\"templateName\":\"welcome_template\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\"]}"
```

---

## Environment Variables Required

```env
WABA_ID=your_whatsapp_business_account_id
WHATSAPP_TOKEN=your_permanent_meta_token
Phone_Number_ID=your_phone_number_id
```

---

## Template Components Structure

### Simple Text Template
```json
{
  "name": "welcome_template",
  "category": "UTILITY",
  "language": "en_US",
  "components": [
    {
      "type": "BODY",
      "text": "Hello {{1}}, welcome to our service"
    }
  ]
}
```

### Template with Header
```json
{
  "name": "promo_template",
  "category": "MARKETING",
  "language": "en_US",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Special Offer!"
    },
    {
      "type": "BODY",
      "text": "Hi {{1}}, get {{2}}% off today!"
    }
  ]
}
```

---

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/templates/create` | Submit template to Meta for approval |
| GET | `/api/templates/meta` | Fetch templates from Meta (shows status) |
| GET | `/api/templates` | Get local templates from database |
| POST | `/api/messages/send-template` | Send approved template to user |

---

## Notes

- Templates must be approved by Meta before they can be used
- Status updates automatically when you call `/api/templates/meta`
- PENDING templates cannot be sent until approved
- Only APPROVED templates can be used in `/api/messages/send-template`

