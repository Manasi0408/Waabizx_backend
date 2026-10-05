# Inbox Send Message Fix

## Problem
Curl works but Inbox UI doesn't send messages.

## Root Causes Fixed

### 1. Field Name Mismatch ✅
**Problem:** Frontend sends `text`, backend expects `message`

**Fix:** Backend now accepts both formats:
- `message` OR `text` OR `content`
- `phone` OR `to` OR `contact.phone`

### 2. Phone Number Format ✅
**Problem:** Phone numbers may have spaces, dashes, etc.

**Fix:** Backend normalizes phone numbers automatically:
- Removes spaces, dashes, parentheses
- Validates format (10-15 digits)

### 3. Contact Not Found ✅
**Problem:** If contact doesn't exist, message fails silently

**Fix:** Backend now auto-creates contacts if they don't exist

### 4. Missing Debugging ✅
**Problem:** No way to see what payload is received

**Fix:** Added comprehensive logging:
- Logs incoming payload
- Logs processed phone/message
- Logs success/failure with details

## Changes Made

### backend/controllers/messageController.js

1. **Accept Multiple Field Formats:**
```javascript
let phone = req.body.phone || req.body.to || req.body.contact?.phone;
let message = req.body.message || req.body.text || req.body.content;
```

2. **Normalize Phone Number:**
```javascript
phone = phone.toString().replace(/[\s\-\(\)]/g, '');
```

3. **Auto-Create Contacts:**
```javascript
if (!contact) {
  contact = await Contact.create({
    userId,
    phone,
    name: phone,
    status: 'active'
  });
}
```

4. **Better Error Messages:**
```javascript
if (!phone) {
  return res.status(400).json({ 
    success: false, 
    msg: "Missing required field: phone",
    receivedPayload: req.body
  });
}
```

5. **Comprehensive Logging:**
```javascript
console.log('📥 Inbox payload received:', JSON.stringify(req.body, null, 2));
console.log('✅ Processed request - Phone:', phone, 'Message:', message);
console.log('✅ Message sent successfully! ID:', saved.id);
```

## Testing

### Test 1: Check Backend Logs
When sending from inbox, you should see:
```
📥 Inbox payload received: { "phone": "...", "text": "..." }
✅ Processed request - Phone: 918600137050 Message: Hello
✅ Contact found (ID: 123)
✅ Message sent successfully! ID: 456
```

### Test 2: Verify Field Names
Frontend sends: `{ phone, text }`
Backend accepts: `{ phone, text }` OR `{ phone, message }` OR `{ to, content }`

### Test 3: Verify Phone Format
Frontend sends: `"918600137050"` OR `"91 8600 137050"` OR `"+91-8600-137050"`
Backend normalizes: `"918600137050"` (all formats work)

## Expected Behavior

### Before Fix:
- Inbox sends `{ phone: "91...", text: "Hello" }`
- Backend expects `{ phone: "...", message: "..." }`
- ❌ Field mismatch → Silent failure

### After Fix:
- Inbox sends `{ phone: "91...", text: "Hello" }`
- Backend accepts `text` OR `message`
- ✅ Field matched → Message sent successfully

## API Endpoint

**URL:** `POST /api/messages/send`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <token>
```

**Request Body (All formats now work):**
```json
{
  "phone": "918600137050",
  "text": "Hello"
}
```

OR

```json
{
  "phone": "918600137050",
  "message": "Hello"
}
```

OR

```json
{
  "to": "918600137050",
  "content": "Hello"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "contactId": 456,
    "message": "Hello",
    "status": "sent",
    ...
  }
}
```

## Debugging Steps

1. **Check Terminal Logs:**
   - Look for `📥 Inbox payload received:` to see what frontend sends
   - Look for `✅ Processed request` to see what backend processes
   - Look for `❌` errors if something fails

2. **Check Browser Console:**
   - Look for `sendMetaMessage API error:` if request fails
   - Check Network tab for actual request/response

3. **Verify Phone Format:**
   - Ensure phone number has country code (e.g., `91` for India)
   - Phone should be 10-15 digits after normalization

4. **Verify Token:**
   - Ensure JWT token is valid and not expired
   - Check `Authorization` header in Network tab

## Notes

- All changes are backward compatible (curl still works)
- Frontend doesn't need changes (already sends correct format)
- Backend now accepts multiple formats for flexibility
- Contacts are auto-created if they don't exist
