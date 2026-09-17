# Testing Message Send API

## Authentication Required

The `/api/messages/send` endpoint now requires authentication. You need to include a JWT token in the request.

## Step 1: Get Authentication Token

First, login to get a token:

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"your_email@example.com\",\"password\":\"your_password\"}"
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { ... }
}
```

Copy the `token` value.

## Step 2: Send Message with Token

Use the token in the Authorization header:

```bash
curl -X POST http://localhost:5000/api/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d "{\"phone\":\"918600137050\",\"message\":\"Hello from CURL\"}"
```

**Note:** You no longer need to send `userId` in the body - it's automatically taken from the authenticated user.

## Without API Credentials

If you haven't set up `PHONE_NUMBER_ID` and `PERMANENT_TOKEN` in your `.env` file yet:

- ✅ The endpoint will still work
- ✅ The message will be saved to the database
- ⚠️  The message status will be `failed`
- ⚠️  The message won't actually be sent via WhatsApp

**Response (without credentials):**
```json
{
  "success": false,
  "msg": "API credentials not configured. Message saved but not sent.",
  "data": {
    "id": 15,
    "contactId": 3,
    "userId": 1,
    "direction": "outgoing",
    "message": "Hello from CURL",
    "type": "text",
    "status": "failed",
    ...
  },
  "warning": {
    "PHONE_NUMBER_ID": "Missing",
    "PERMANENT_TOKEN": "Missing",
    "message": "Add credentials to .env file to enable actual message sending"
  }
}
```

## With API Credentials

Once you add `PHONE_NUMBER_ID` and `PERMANENT_TOKEN` to your `.env` file:

**Response (with credentials):**
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

## Complete Example

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}' \
  | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 2. Send message
curl -X POST http://localhost:5000/api/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"phone":"918600137050","message":"Hello from CURL"}'
```

## Error Responses

### 401 Unauthorized (No Token)
```json
{
  "success": false,
  "message": "Not authorized to access this route"
}
```

### 400 Bad Request (Missing Fields)
```json
{
  "success": false,
  "msg": "Missing required fields: phone, message"
}
```

### 404 Not Found (Contact Not Found)
```json
{
  "success": false,
  "msg": "Contact not found"
}
```

