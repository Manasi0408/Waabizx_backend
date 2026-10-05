# Campaign API - CURL Commands

## Prerequisites

1. **JWT Token**: Get your JWT token by logging in
2. **Environment Variables**: Ensure `PHONE_NUMBER_ID` and `PERMANENT_TOKEN` (or `WHATSAPP_TOKEN`) are set in `.env`

---

## 1️⃣ Create Campaign

**POST** `/api/campaigns`

### Request Body:
```json
{
  "name": "New Year Offer",
  "template_name": "new_year_offer",
  "template_language": "en_US",
  "schedule_time": null,
  "audience": [
    {"phone":"91999999999","var1":"John","var2":"1234"},
    {"phone":"91888888888","var1":"Riya","var2":"5656"}
  ]
}
```

### Windows CMD:
```bash
curl -X POST "http://localhost:5000/api/campaigns" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"New Year Offer\",\"template_name\":\"new_year_offer\",\"template_language\":\"en_US\",\"schedule_time\":null,\"audience\":[{\"phone\":\"91999999999\",\"var1\":\"John\",\"var2\":\"1234\"},{\"phone\":\"91888888888\",\"var1\":\"Riya\",\"var2\":\"5656\"}]}"
```

### With Scheduled Time:
```bash
curl -X POST "http://localhost:5000/api/campaigns" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"New Year Offer\",\"template_name\":\"new_year_offer\",\"template_language\":\"en_US\",\"schedule_time\":\"2026-01-15 10:00:00\",\"audience\":[{\"phone\":\"91999999999\",\"var1\":\"John\",\"var2\":\"1234\"}]}"
```

### Expected Response:
```json
{
  "success": true,
  "campaignId": 10,
  "status": "PENDING"
}
```

---

## 2️⃣ Get Campaign List

**GET** `/api/campaigns`

### Windows CMD:
```bash
curl -X GET "http://localhost:5000/api/campaigns" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "campaigns": [
    {
      "id": 10,
      "name": "New Year Offer",
      "template_name": "new_year_offer",
      "status": "PENDING",
      "total": 2,
      "sent": 0,
      "delivered": 0,
      "read": 0,
      "failed": 0,
      "createdAt": "2026-01-13T10:00:00.000Z",
      "updatedAt": "2026-01-13T10:00:00.000Z"
    }
  ]
}
```

---

## 3️⃣ Get Single Campaign + Stats

**GET** `/api/campaigns/:id`

### Windows CMD:
```bash
curl -X GET "http://localhost:5000/api/campaigns/10" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "id": 10,
  "name": "New Year Offer",
  "status": "PROCESSING",
  "stats": {
    "total": 5000,
    "sent": 2000,
    "delivered": 1500,
    "read": 900,
    "failed": 50
  }
}
```

---

## 4️⃣ Start Campaign Manually

**POST** `/api/campaigns/:id/start`

### Windows CMD:
```bash
curl -X POST "http://localhost:5000/api/campaigns/10/start" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "message": "Campaign started successfully",
  "campaignId": 10,
  "status": "PROCESSING"
}
```

**Note:** This will start sending messages immediately at 20 messages/second.

---

## 5️⃣ Pause Campaign

**POST** `/api/campaigns/:id/pause`

### Windows CMD:
```bash
curl -X POST "http://localhost:5000/api/campaigns/10/pause" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "message": "Campaign paused successfully",
  "campaignId": 10,
  "status": "PAUSED"
}
```

---

## 6️⃣ Resume Campaign

**POST** `/api/campaigns/:id/resume`

### Windows CMD:
```bash
curl -X POST "http://localhost:5000/api/campaigns/10/resume" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "message": "Campaign resumed successfully",
  "campaignId": 10,
  "status": "PROCESSING"
}
```

---

## 7️⃣ Campaign Logs (Audience Status)

**GET** `/api/campaigns/:id/audience`

### Windows CMD:
```bash
curl -X GET "http://localhost:5000/api/campaigns/10/audience" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Expected Response:
```json
{
  "success": true,
  "audience": [
    {
      "id": 1,
      "phone": "91999999999",
      "var1": "John",
      "var2": "1234",
      "status": "sent",
      "waMessageId": "wamid.HBgLM...",
      "errorMessage": null,
      "sentAt": "2026-01-13T10:05:00.000Z",
      "deliveredAt": null,
      "readAt": null
    },
    {
      "id": 2,
      "phone": "91888888888",
      "var1": "Riya",
      "var2": "5656",
      "status": "failed",
      "waMessageId": null,
      "errorMessage": "Invalid phone number",
      "sentAt": null,
      "deliveredAt": null,
      "readAt": null
    }
  ]
}
```

---

## 📋 Campaign Status Values

- **PENDING**: Campaign created but not started
- **PROCESSING**: Campaign is actively sending messages
- **PAUSED**: Campaign is paused (can be resumed)
- **COMPLETED**: All messages have been sent

---

## 🚀 Complete Workflow Example

### Step 1: Create Campaign
```bash
curl -X POST "http://localhost:5000/api/campaigns" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN" ^
  -d "{\"name\":\"Test Campaign\",\"template_name\":\"hello_world\",\"template_language\":\"en_US\",\"schedule_time\":null,\"audience\":[{\"phone\":\"91999999999\",\"var1\":\"John\"}]}"
```

**Response:** `{"success":true,"campaignId":10,"status":"PENDING"}`

### Step 2: Start Campaign
```bash
curl -X POST "http://localhost:5000/api/campaigns/10/start" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:** `{"success":true,"message":"Campaign started successfully","campaignId":10,"status":"PROCESSING"}`

### Step 3: Check Status
```bash
curl -X GET "http://localhost:5000/api/campaigns/10" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:** Shows current stats (sent, delivered, read, failed)

### Step 4: Check Audience Logs
```bash
curl -X GET "http://localhost:5000/api/campaigns/10/audience" ^
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:** Shows individual message statuses

---

## ⚠️ Important Notes

1. **Template Name**: Must be an approved template in Meta Business Manager
2. **Template Variables**: Use `var1`, `var2`, `var3`, `var4`, `var5` for template parameters
3. **Phone Format**: Use international format (e.g., `91999999999` for India)
4. **Rate Limiting**: Campaigns send at 20 messages/second
5. **Status Updates**: Message status (delivered, read) is updated via webhook

---

## 🔧 Environment Variables Required

```env
PHONE_NUMBER_ID=your_phone_number_id
PERMANENT_TOKEN=your_permanent_token
# OR
WHATSAPP_TOKEN=your_token
```

---

## 📊 Template Variables Mapping

When creating a campaign, template variables are mapped as:
- `var1` → First template parameter ({{1}})
- `var2` → Second template parameter ({{2}})
- `var3` → Third template parameter ({{3}})
- `var4` → Fourth template parameter ({{4}})
- `var5` → Fifth template parameter ({{5}})

Example template: `"Hello {{1}}, your order {{2}} is ready!"`
Campaign audience: `{"phone":"91999999999","var1":"John","var2":"12345"}`

