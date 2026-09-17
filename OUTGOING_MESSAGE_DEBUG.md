# Outgoing Message Debugging Guide

## Issue: Messages Saved to DB but Not Reaching WhatsApp

### What to Check

#### 1. Environment Variables ✅
Check if these variables are set in your `.env` file:

```env
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_TOKEN=your_permanent_token
```

**OR these alternative names (also supported):**
```env
PHONE_NUMBER_ID=your_phone_number_id
PERMANENT_TOKEN=your_permanent_token
```

**OR:**
```env
Phone_Number_ID=your_phone_number_id
Whatsapp_Token=your_permanent_token
```

#### 2. Backend Terminal Logs

When you send a message from the inbox, check the backend terminal for these logs:

**If credentials are found:**
```
🔍 Checking environment variables...
  WHATSAPP_PHONE_NUMBER_ID: ✓ Found
  Selected PHONE_NUMBER_ID: 123456789012345
  Selected TOKEN: EAABsbCS1iH...
📤 Sending to Meta API...
  URL: https://graph.facebook.com/v21.0/123456789012345/messages
  Payload: { "messaging_product": "whatsapp", ... }
✅ Meta API Response Status: 200
✅ WhatsApp Message ID: wamid.xxx
✅ Message successfully sent to WhatsApp!
```

**If credentials are missing:**
```
❌ Missing Meta WhatsApp API credentials!
  PHONE_NUMBER_ID: ✗ Missing
  TOKEN: ✗ Missing
```

**If API call fails:**
```
❌ Meta API Error occurred!
  Error Type: AxiosError
  Response Status: 400 (or 401, 403, etc.)
  Response Data: { "error": { "message": "...", "code": ... } }
  Error Code: 131047 (or other error code)
  Error Message: ...
```

### Common Issues

#### Issue 1: Missing Environment Variables
**Symptoms:**
- Terminal shows: `❌ Missing Meta WhatsApp API credentials!`
- Message saved to DB with `status = 'failed'`

**Fix:**
1. Add environment variables to `.env` file
2. Restart the backend server
3. Try sending message again

#### Issue 2: Wrong Environment Variable Names
**Symptoms:**
- Terminal shows all variables as "✗ Missing"
- But you have variables in `.env` with different names

**Fix:**
- Use one of these names in `.env`:
  - `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN` (preferred)
  - `PHONE_NUMBER_ID` and `PERMANENT_TOKEN`
  - `Phone_Number_ID` and `Whatsapp_Token`

#### Issue 3: Invalid Token
**Symptoms:**
- Terminal shows: `Response Status: 401`
- Error: `"Invalid OAuth access token"`

**Fix:**
- Regenerate token in Meta Business Manager
- Update `.env` file with new token
- Restart server

#### Issue 4: Wrong Phone Number ID
**Symptoms:**
- Terminal shows: `Response Status: 400` or `404`
- Error: `"Invalid phone number ID"`

**Fix:**
- Get correct Phone Number ID from Meta Business Manager
- Update `.env` file
- Restart server

#### Issue 5: 24-Hour Session Expired
**Symptoms:**
- Terminal shows: `Error Code: 131047` or `131026`
- Error message contains: `"24 hour"` or `"session"`

**Fix:**
- Use `/send-template` endpoint to send template message first
- OR wait for user to send you a message
- Template message opens 24-hour window for free-text messages

#### Issue 6: API Call Not Being Made
**Symptoms:**
- Message saved to DB but no API logs
- No "📤 Sending to Meta API..." log

**Fix:**
- Check if credentials are being read (see logs above)
- Verify `.env` file is in correct location (backend folder)
- Restart server after changing `.env`

### Debugging Steps

1. **Check Environment Variables:**
   ```bash
   # In backend terminal, you should see:
   🔍 Checking environment variables...
     Selected PHONE_NUMBER_ID: <should show your ID>
     Selected TOKEN: <should show first chars of token>
   ```

2. **Send Message from Inbox:**
   - Type a message and click Send
   - Watch backend terminal immediately

3. **Check for API Call:**
   - Should see: `📤 Sending to Meta API...`
   - Should see: `URL: https://graph.facebook.com/...`

4. **Check for Response:**
   - Success: `✅ Meta API Response Status: 200`
   - Failure: `❌ Meta API Error occurred!`

5. **Check Database:**
   ```sql
   SELECT * FROM InboxMessages 
   WHERE direction = 'outgoing' 
   ORDER BY timestamp DESC 
   LIMIT 1;
   ```
   
   - `status` should be `'sent'` if API succeeded
   - `status` should be `'failed'` if API failed
   - `waMessageId` should have value if succeeded (e.g., `wamid.xxx`)

### Expected Flow

1. ✅ User sends message from inbox
2. ✅ Backend receives payload (see: `📥 Inbox payload received`)
3. ✅ Backend checks credentials (see: `🔍 Checking environment variables...`)
4. ✅ Backend calls Meta API (see: `📤 Sending to Meta API...`)
5. ✅ Meta API responds (see: `✅ Meta API Response Status: 200`)
6. ✅ Backend saves to DB with `status = 'sent'` and `waMessageId`
7. ✅ Message appears in WhatsApp
8. ✅ Socket event emitted for real-time update

### What to Share for Debugging

If still not working, share these from backend terminal:

1. Environment variable check logs
2. API call logs (`📤 Sending to Meta API...`)
3. API response logs (success or error)
4. Any error messages

Also check:
- `.env` file contents (hide token - just show variable names)
- Database `InboxMessages` table: `status` and `waMessageId` values

