# AiSensy API Fixes - Text & Media Messages

## Issues Fixed

### ✅ Issue 1: Duplicate Phone Number Error
**Problem:** `Contact.create()` was causing duplicate phone errors because phone has unique constraint.

**Fix:** Changed to find by phone first, then create or update:
```javascript
// Find contact by phone (unique constraint)
let contact = await Contact.findOne({ where: { phone } });

if (!contact) {
  contact = await Contact.create({ userId, phone, name: phone, status: 'active' });
} else {
  // Update userId if different
  if (contact.userId !== userId) {
    await contact.update({ userId });
  }
}
```

**Files Fixed:**
- `backend/controllers/metaMessageController.js` (lines 98-112, 136-150)
- `backend/controllers/inboxController.js` (already fixed)

### ✅ Issue 2: AiSensy "Media URL Missing" Error
**Problem:** AiSensy was complaining about missing media URL even for text messages.

**Fix:** 
1. Changed payload format from `text: { body: text }` to `message: text`
2. Added phone normalization (ensures + prefix)
3. Added support for media messages
4. Explicitly exclude media fields for text messages

**Files Fixed:**
- `backend/services/aisensyService.js`

## Current Payload Format

### Text Message (Correct Format):
```json
{
  "apiKey": "***",
  "campaignName": "agentcrm_api2",
  "destination": "+919822426339",
  "userName": "User",
  "source": "WhatsApp",
  "message": "Hello",  // ✅ Correct field name
  "tags": [],
  "attributes": {}
}
```

### Media Message (New Support):
```json
{
  "apiKey": "***",
  "campaignName": "agentcrm_api2",
  "destination": "+919822426339",
  "userName": "User",
  "source": "WhatsApp",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaType": "image",
  "message": "Caption text",
  "tags": [],
  "attributes": {}
}
```

## Important Notes

### ⚠️ Campaign Configuration
If you still get "Media URL Missing" error for text messages, it means:
- Your campaign `agentcrm_api2` is configured for **media messages only**
- You need to either:
  1. Create a **text-only campaign** in AiSensy dashboard
  2. OR configure the campaign to accept both text and media

### 📞 Phone Number Format
- Phone numbers are now automatically normalized to include `+` prefix
- Format: `+919822426339` (country code + number)
- If phone doesn't have `+`, it's automatically added

## API Usage

### Send Text Message:
```javascript
POST /api/messages/send
{
  "phone": "919822426339",
  "text": "Hello"
}
```

### Send Media Message:
```javascript
POST /api/messages/send
{
  "phone": "919822426339",
  "text": "Check this out!",
  "type": "media",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaType": "image"
}
```

## Testing

1. **Send text message** - Should work if campaign is text-configured
2. **Check backend logs** - Should see:
   ```
   📞 Phone normalized: 919822426339 → +919822426339
   💬 Sending text-only message (no media): Hello
   📤 SENDING TO AISENSY: { "message": "Hello", ... }
   ```

3. **If still getting "Media URL Missing":**
   - Check campaign configuration in AiSensy dashboard
   - Campaign must be configured for TEXT messages, not media
   - Or create a new text-only campaign

## Files Changed

1. ✅ `backend/services/aisensyService.js`
   - Fixed payload format (`message` instead of `text.body`)
   - Added phone normalization
   - Added media message support
   - Better error logging

2. ✅ `backend/controllers/metaMessageController.js`
   - Fixed duplicate phone error (findOrCreate pattern)
   - Added mediaUrl and mediaType parameter support

3. ✅ `backend/controllers/inboxController.js`
   - Already fixed (findOrCreate)

## Next Steps

If "Media URL Missing" error persists:
1. Check AiSensy dashboard - campaign configuration
2. Create a text-only campaign if needed
3. Update `WHATSAPP_CAMPAIGN_NAME` in `.env` to use text-only campaign

