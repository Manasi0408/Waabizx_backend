# Verified & Non-Verified Number Support

## Overview

The system now supports both **verified** and **non-verified** WhatsApp Business numbers.

## How It Works

### ✅ Verified Numbers
- **No restrictions** - Can send messages anytime
- `/send` endpoint works without any limitations
- No 24-hour window restrictions

### ⚠️ Non-Verified Numbers
- **24-hour messaging window** enforced by Meta
- Can only send free-form messages within 24 hours after user messages you
- Outside 24-hour window, must use template messages

## Two Use Cases

### Case 1: Click to Chat (User Starts Conversation)

**Flow:**
1. User clicks `wa.me/YourBusinessNumber` link
2. User sends a message
3. Webhook receives the message → Updates `lastContacted` timestamp
4. You can now use `/send` to reply (24-hour window active)
5. ✅ Works for both verified and non-verified numbers

**Example:**
```bash
# User sends message via WhatsApp
# Webhook automatically updates contact.lastContacted

# Now you can reply using /send
curl -X POST http://localhost:5000/api/messages/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"918600137050","message":"Hello! How can I help?"}'
```

### Case 2: You Start First (Template Required)

**Flow:**
1. You call `/send-template` to send an approved template
2. User receives the template message
3. User replies to your template
4. Webhook receives reply → Updates `lastContacted` timestamp
5. Now `/send` works normally (24-hour window active)

**Example:**
```bash
# Step 1: Send template message
curl -X POST http://localhost:5000/api/messages/send-template \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phone":"918600137050",
    "templateName":"hello_world",
    "templateLanguage":"en_US",
    "templateParams":["John"]
  }'

# Step 2: User replies to template
# Webhook automatically updates contact.lastContacted

# Step 3: Now you can use /send normally
curl -X POST http://localhost:5000/api/messages/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"918600137050","message":"Thanks for your reply!"}'
```

## API Endpoints

### POST `/api/messages/send`
Send a free-form text message.

**Request:**
```json
{
  "phone": "918600137050",
  "message": "Hello from API"
}
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
    "message": "Hello from API",
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
  "msg": "24 hour session expired. User must send a message first, or use /send-template to send a template message.",
  "error": "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
  "errorCode": 131047
}
```

### POST `/api/messages/send-template`
Send an approved WhatsApp template message.

**Request:**
```json
{
  "phone": "918600137050",
  "templateName": "hello_world",
  "templateLanguage": "en_US",
  "templateParams": ["John", "Doe"]
}
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

## How 24-Hour Window Works

1. **User sends message** → Webhook updates `contact.lastContacted` → 24-hour window starts
2. **You send template** → Template sent → User replies → Webhook updates `contact.lastContacted` → 24-hour window starts
3. **Within 24 hours** → `/send` works normally
4. **After 24 hours** → `/send` returns error → Must use `/send-template` again

## Automatic Handling

The system **automatically detects** if you're using a verified or non-verified number:

- **Verified numbers**: Meta API accepts all messages → No errors
- **Non-verified numbers**: Meta API returns error code `131047` if outside 24-hour window → System catches it and returns helpful message

## Key Points

✅ **No code changes needed** - Works automatically for both verified and non-verified numbers
✅ **Webhook automatically updates** `lastContacted` when user sends message
✅ **Template endpoint** opens 24-hour window for non-verified numbers
✅ **Error handling** provides clear messages when 24-hour restriction applies

## Testing

### Test Case 1: User Starts (Click to Chat)
1. Send a message from WhatsApp to your business number
2. Check webhook logs - should see `lastContacted` updated
3. Use `/send` to reply - should work ✅

### Test Case 2: You Start (Template)
1. Use `/send-template` to send a template
2. User replies to template
3. Check webhook logs - should see `lastContacted` updated
4. Use `/send` to reply - should work ✅

### Test Case 3: 24-Hour Expired
1. Wait 24+ hours after last contact
2. Try `/send` - should return `sessionExpired: true` error
3. Use `/send-template` to restart conversation ✅

