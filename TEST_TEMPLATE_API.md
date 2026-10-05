# Testing Template API Endpoints

## 1. Get Meta WhatsApp Templates

**Endpoint:** `GET /api/templates/meta`

**Requires:** Authentication token

**CURL Command:**
```cmd
curl -X GET http://localhost:5000/api/templates/meta -H "Authorization: Bearer YOUR_TOKEN"
```

**Steps:**
1. First, login to get token:
```cmd
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"your_email@example.com\",\"password\":\"your_password\"}"
```

2. Copy the `token` from response

3. Use token in request:
```cmd
curl -X GET http://localhost:5000/api/templates/meta -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Success Response:**
```json
{
  "success": true,
  "templates": [
    {
      "name": "hello_world",
      "language": "en_US",
      "status": "APPROVED",
      "category": "MARKETING",
      ...
    }
  ]
}
```

---

## 2. Get Local Templates (from database)

**Endpoint:** `GET /api/templates`

**Requires:** Authentication token

**CURL Command:**
```cmd
curl -X GET http://localhost:5000/api/templates -H "Authorization: Bearer YOUR_TOKEN"
```

**With Query Parameters:**
```cmd
curl -X GET "http://localhost:5000/api/templates?page=1&limit=20&category=promotional" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Complete Example (Windows CMD)

```cmd
REM Step 1: Login
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"test@example.com\",\"password\":\"password123\"}"

REM Step 2: Get Meta Templates (replace YOUR_TOKEN with actual token)
curl -X GET http://localhost:5000/api/templates/meta -H "Authorization: Bearer YOUR_TOKEN"

REM Step 3: Get Local Templates
curl -X GET http://localhost:5000/api/templates -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Environment Variables Required

Make sure your `.env` file has:
```env
WABA_ID=your_whatsapp_business_account_id
WHATSAPP_TOKEN=your_whatsapp_token
```

---

## Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "message": "Not authorized to access this route"
}
```
**Solution:** Include `Authorization: Bearer YOUR_TOKEN` header

### 400 Bad Request (Missing Env Vars)
```json
{
  "success": false,
  "message": "WABA_ID and WHATSAPP_TOKEN are required in environment variables"
}
```
**Solution:** Add `WABA_ID` and `WHATSAPP_TOKEN` to `.env` file

### 500 Server Error (Meta API Error)
```json
{
  "success": false,
  "message": "Failed to fetch templates",
  "error": { ... }
}
```
**Solution:** Check your `WABA_ID` and `WHATSAPP_TOKEN` are correct

