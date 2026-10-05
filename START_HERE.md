# 🎯 START HERE - Follow These Steps

## Step 1: Open Postman

## Step 2: Create New Request

1. Click "New" → "HTTP Request"
2. Set method to: **POST**
3. Enter URL: `http://localhost:5000/api/auth/debug`

## Step 3: Set Headers

1. Click "Headers" tab
2. Add new header:
   - Key: `Content-Type`
   - Value: `application/json`

## Step 4: Set Body

1. Click "Body" tab
2. Click the radio button: **"raw"**
3. Click the dropdown on the right → Select **"JSON"**
4. Paste this in the text box:
```json
{
  "name": "Test User",
  "email": "test@test.com",
  "password": "test123"
}
```

## Step 5: Click "Send"

## Step 6: Look at Response

**At the bottom of Postman, you'll see the response.**

**If you see:**
```json
{
  "check": {
    "hasName": true,
    "hasEmail": true,
    "hasPassword": true
  }
}
```

✅ **GOOD!** Your Postman is working correctly!

**Now test register:**
- Change URL to: `http://localhost:5000/api/auth/register`
- Click "Send" again
- Tell me what error you see

---

**If you see:**
```json
{
  "check": {
    "hasName": false,
    "hasEmail": false,
    "hasPassword": false
  }
}
```

❌ **PROBLEM!** Your Postman is not sending data.

**Fix:**
1. Make sure "Body" tab → "raw" is selected
2. Make sure dropdown says "JSON" (not "Text")
3. Make sure Headers has `Content-Type: application/json`

---

## Still Having Issues?

**Tell me:**
1. What do you see in the `/debug` response?
2. What error do you see when testing `/register`?
3. Can you see the server console? What does it show?

