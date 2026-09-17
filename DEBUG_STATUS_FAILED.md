# Debug: Messages Saved with Status = 'failed'

## Issue
Messages are being saved to database with `status = 'failed'` and not reaching WhatsApp.

## Root Causes

### 1. Missing Environment Variables ❌
**Symptoms:**
- Status in DB: `'failed'`
- Backend terminal shows: `❌ Missing Meta WhatsApp API credentials!`
- No API call is made

**Fix:**
Add to `.env` file (in backend folder):
```env
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_TOKEN=your_permanent_token
```

Then restart backend server.

### 2. Meta API Call Failed ❌
**Symptoms:**
- Status in DB: `'failed'`
- Backend terminal shows: `❌ Meta API Error occurred!`
- Error code shown (e.g., 131047, 401, 403, etc.)

**Common Error Codes:**

#### Error Code 131047 / 131026 - 24 Hour Session Expired
**Error Message:** `"The session is expired. Please send a template message first."`

**Fix:**
- Use `/send-template` endpoint to send a template message first
- OR wait for user to send you a message
- Template message opens 24-hour window

#### Error Code 401 - Invalid Token
**Error Message:** `"Invalid OAuth access token"`

**Fix:**
- Token is expired or invalid
- Regenerate token in Meta Business Manager
- Update `.env` file with new token
- Restart server

#### Error Code 403 - Permission Denied
**Error Message:** `"Permission denied"`

**Fix:**
- Token doesn't have required permissions
- Check token permissions in Meta Business Manager
- Regenerate token with correct permissions

#### Error Code 400 - Bad Request
**Error Message:** `"Invalid parameter"` or `"Invalid phone number"`

**Fix:**
- Check phone number format (must be: country code + number, e.g., `919876543210`)
- Verify Phone Number ID is correct
- Check API payload format

## How to Debug

### Step 1: Check Backend Terminal Logs

Send a message from inbox and look for these logs:

#### If Credentials Missing:
```
🔍 Checking environment variables...
  WHATSAPP_PHONE_NUMBER_ID: ✗ Missing
  Selected PHONE_NUMBER_ID: NONE
  Selected TOKEN: NONE
❌ Missing Meta WhatsApp API credentials!
💾 Saving message to database with status=failed (credentials missing)...
💾 Message saved to DB with status=failed (ID: 123)
   Reason: API credentials not configured
```

**Solution:** Add environment variables to `.env` and restart server.

#### If API Call Failed:
```
🔍 Checking environment variables...
  Selected PHONE_NUMBER_ID: 123456789012345
  Selected TOKEN: EAABsbCS1iH...
📤 Sending to Meta API...
❌ Meta API Error occurred!
  Response Status: 400
  Error Code: 131047
  Error Message: The session is expired...
💾 Saving failed message to database with error details...
💾 Failed message saved to DB (ID: 123)
   Error: [131047] The session is expired...
   Error Code: 131047
❌ META API CALL FAILED - Message not sent to WhatsApp
```

**Solution:** Check error code and follow fixes above.

### Step 2: Check Database

Query the database to see the last failed message:

```sql
SELECT 
  id,
  contactId,
  direction,
  message,
  status,
  waMessageId,
  timestamp
FROM InboxMessages 
WHERE direction = 'outgoing' 
  AND status = 'failed' 
ORDER BY timestamp DESC 
LIMIT 1;
```

**What to look for:**
- `status = 'failed'` - Confirms failure
- `waMessageId = NULL` - No WhatsApp message ID (API call failed)
- `timestamp` - When it failed

### Step 3: Verify Environment Variables

Check if `.env` file exists and has correct values:

**Location:** `backend/.env`

**Required:**
```env
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_TOKEN=EAABsbCS1iHgBO7ZC...
```

**To verify:**
1. Open `backend/.env` file
2. Check if `WHATSAPP_PHONE_NUMBER_ID` exists and has value
3. Check if `WHATSAPP_TOKEN` exists and has value (should start with `EAAB`)
4. Make sure no extra spaces or quotes around values
5. Save file
6. **Restart backend server** (important!)

## Quick Fix Checklist

- [ ] Check backend terminal for error logs
- [ ] Verify `.env` file has `WHATSAPP_PHONE_NUMBER_ID`
- [ ] Verify `.env` file has `WHATSAPP_TOKEN`
- [ ] Restart backend server after changing `.env`
- [ ] Check if token is valid (not expired)
- [ ] Check if phone number format is correct (country code + number)
- [ ] If error code 131047/131026: Use template message first
- [ ] Check if Phone Number ID is correct

## Most Common Issue

**99% of cases:** Missing or incorrect environment variables in `.env` file.

**Solution:**
1. Check `.env` file has both variables
2. Verify variable names are correct (no typos)
3. Remove any quotes around values
4. **Restart backend server** after changes

## Next Steps

After fixing:
1. Send message from inbox
2. Check backend terminal - should see:
   ```
   ✅ Meta API Response Status: 200
   ✅ WhatsApp Message ID: wamid.xxx
   ✅ Message successfully sent to WhatsApp!
   ```
3. Check database - `status` should be `'sent'` and `waMessageId` should have value
4. Check WhatsApp - message should appear

