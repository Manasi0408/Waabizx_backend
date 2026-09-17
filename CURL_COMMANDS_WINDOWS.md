# CURL Commands for Windows CMD

## Prerequisites
- Make sure your backend server is running on `http://localhost:5000`
- Replace `YOUR_TOKEN` with actual JWT token from login

---

## 1. Login (Get Authentication Token)

```cmd
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"your_email@example.com\",\"password\":\"your_password\"}"
```

**Save token from response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { ... }
}
```

**Copy the token value** - you'll need it for other requests.

---

## 2. Send Message (Free Text)

```cmd
curl -X POST http://localhost:5000/api/messages/send -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"phone\":\"918600137050\",\"message\":\"Hello from CURL\"}"
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "id": 15,
    "contactId": 3,
    "userId": 1,
    "direction": "outgoing",
    "message": "Hello from CURL",
    "type": "text",
    "status": "sent",
    "waMessageId": "wamid.HBgLM...",
    "timestamp": "2026-01-12T13:40:10.000Z"
  }
}
```

**24-Hour Restriction Error (Non-Verified):**
```json
{
  "success": false,
  "sessionExpired": true,
  "msg": "24 hour session expired. User must send a message first, or use /send-template to send a template message."
}
```

---

## 3. Send Template Message

```cmd
curl -X POST http://localhost:5000/api/messages/send-template -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"phone\":\"918600137050\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\"]}"
```

**With Multiple Parameters:**
```cmd
curl -X POST http://localhost:5000/api/messages/send-template -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"phone\":\"918600137050\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\",\"templateParams\":[\"John\",\"Doe\"]}"
```

**Success Response:**
```json
{
  "success": true,
  "data": {
    "id": 16,
    "contactId": 3,
    "userId": 1,
    "direction": "outgoing",
    "message": "Template: hello_world",
    "type": "text",
    "status": "sent",
    "waMessageId": "wamid.HBgLM...",
    "timestamp": "2026-01-12T13:40:10.000Z"
  },
  "msg": "Template sent successfully. User can now reply and you can use /send normally."
}
```

---

## 4. Get Inbox List

```cmd
curl -X GET http://localhost:5000/api/inbox -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 5. Get Messages for Contact

```cmd
curl -X GET "http://localhost:5000/api/inbox/918600137050/messages" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 6. Search Messages

```cmd
curl -X GET "http://localhost:5000/api/messages/search?contactId=3&query=hello" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 7. Get Paginated Messages

```cmd
curl -X GET "http://localhost:5000/api/messages/paginated?contactId=3&page=1&limit=50" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 8. Delete Message

```cmd
curl -X DELETE http://localhost:5000/api/messages/15 -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 9. Forward Message

```cmd
curl -X POST http://localhost:5000/api/messages/15/forward -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"contactIds\":[4,5]}"
```

---

## 10. Add Reaction to Message

```cmd
curl -X POST http://localhost:5000/api/messages/15/reaction -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"emoji\":\"👍\"}"
```

---

## 11. Get Webhook Logs

```cmd
curl -X GET "http://localhost:5000/webhook/logs?phone=918600137050" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 12. Get Meta Messages

```cmd
curl -X GET "http://localhost:5000/messages/inbound?phone=918600137050" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Complete Test Flow Example

### Step 1: Login and Save Token
```cmd
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"test@example.com\",\"password\":\"password123\"}" > login_response.json
```

### Step 2: Extract Token (Manual)
Open `login_response.json` and copy the token value.

### Step 3: Send Message
```cmd
curl -X POST http://localhost:5000/api/messages/send -H "Content-Type: application/json" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." -d "{\"phone\":\"918600137050\",\"message\":\"Hello from CURL\"}"
```

### Step 4: Send Template
```cmd
curl -X POST http://localhost:5000/api/messages/send-template -H "Content-Type: application/json" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." -d "{\"phone\":\"918600137050\",\"templateName\":\"hello_world\",\"templateLanguage\":\"en_US\"}"
```

---

## Windows CMD Tips

### Using Variables (Set Token)
```cmd
set TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
curl -X POST http://localhost:5000/api/messages/send -H "Content-Type: application/json" -H "Authorization: Bearer %TOKEN%" -d "{\"phone\":\"918600137050\",\"message\":\"Hello\"}"
```

### Pretty Print JSON (if you have jq installed)
```cmd
curl -X GET http://localhost:5000/api/inbox -H "Authorization: Bearer YOUR_TOKEN" | jq .
```

### Save Response to File
```cmd
curl -X GET http://localhost:5000/api/inbox -H "Authorization: Bearer YOUR_TOKEN" > response.json
```

---

## Common Errors

### 401 Unauthorized
- Token expired or invalid
- Solution: Login again to get new token

### 404 Not Found
- Contact doesn't exist
- Solution: Create contact first or check phone number format

### 500 Server Error
- Check server logs
- Verify environment variables are set (Phone_Number_ID, Whatsapp_Token)

---

## Quick Test Script

Save this as `test_api.bat`:

```batch
@echo off
echo Testing Message API...
echo.

echo 1. Login...
curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d "{\"email\":\"test@example.com\",\"password\":\"password123\"}"
echo.
echo.
echo Copy the token from above and use it in the next command
echo.
pause

echo 2. Send Message (replace YOUR_TOKEN)...
curl -X POST http://localhost:5000/api/messages/send -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN" -d "{\"phone\":\"918600137050\",\"message\":\"Hello from CURL\"}"
echo.
pause
```

