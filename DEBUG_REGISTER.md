# How to Debug Register API 400 Error

## Step-by-Step Debugging Guide

### Step 1: Check Your Postman Request

Make sure your Postman request looks EXACTLY like this:

**Method:** `POST`
**URL:** `http://localhost:5000/api/auth/register`

**Headers Tab:**
```
Content-Type: application/json
```

**Body Tab:**
- Select: `raw`
- Select: `JSON` (dropdown on the right)
- Enter this EXACT JSON:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

⚠️ **Common Mistakes:**
- ❌ Using `form-data` instead of `raw` JSON
- ❌ Missing quotes around field names
- ❌ Trailing commas in JSON
- ❌ Missing Content-Type header

---

### Step 2: Check the Log Files

After making the request, check these files:

**File 1:** `backend/logs/app.log`
- Look for: `REQUEST BODY - POST /api/auth/register`
- This shows what data the server received

**File 2:** `backend/logs/error.log`
- Look for any error messages
- This shows what went wrong

**How to view:**
- Open in Notepad: `backend\logs\app.log`
- Or use PowerShell: `Get-Content backend\logs\app.log -Tail 20`

---

### Step 3: Check Server Console

Look at the CMD/terminal where your server is running.

You should see:
```
[timestamp] REQUEST BODY - POST /api/auth/register
BODY: { name: 'John Doe', email: 'john@example.com', password: 'password123' }
```

If you see `BODY: {}` or `BODY: undefined`, the request body is not being sent correctly.

---

### Step 4: Test the Route First

Before testing register, test if the route works:

**GET** `http://localhost:5000/api/auth/test`

Should return:
```json
{
  "success": true,
  "message": "Auth route is working"
}
```

If this doesn't work, the server isn't running or routes aren't set up.

---

### Step 5: Common 400 Error Causes

#### Error: "Missing required fields"
**Cause:** One or more fields (name, email, password) are missing or empty
**Fix:** Check your JSON body has all three fields with values

#### Error: "Please provide a valid email address"
**Cause:** Email format is wrong
**Fix:** Use format like `user@example.com`

#### Error: "Password must be at least 6 characters long"
**Cause:** Password is too short
**Fix:** Use password with 6+ characters

#### Error: "User already exists with this email"
**Cause:** Email is already registered
**Fix:** Use a different email address

#### Error: "Database error"
**Cause:** Database tables not created
**Fix:** Restart server and check for "Database synchronized successfully" message

---

### Step 6: Quick Test Script

Create a file `test-register.js` in backend folder:

```javascript
const axios = require('axios');

async function testRegister() {
  try {
    const response = await axios.post('http://localhost:5000/api/auth/register', {
      name: 'Test User',
      email: 'test@example.com',
      password: 'test123'
    });
    console.log('✅ Success:', response.data);
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
  }
}

testRegister();
```

Run: `node test-register.js`

---

### Step 7: Still Not Working?

1. **Check server is running:** Look for "Server running on port 5000"
2. **Check database connected:** Look for "Database connected"
3. **Check database synced:** Look for "Database synchronized successfully"
4. **Check .env file:** Make sure JWT_SECRET is set
5. **Restart server:** Stop (Ctrl+C) and run `npm run dev` again

---

## What to Share for Help

If you still can't fix it, share:
1. The exact error message from Postman response
2. Contents of `backend/logs/app.log` (last 20 lines)
3. Contents of `backend/logs/error.log` (if exists)
4. Screenshot of your Postman request (Headers + Body tabs)

