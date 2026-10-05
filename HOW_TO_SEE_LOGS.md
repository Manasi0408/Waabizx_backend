# 📺 How to See Logs in Terminal

## Simple Steps

### 1. Start Server
```bash
cd D:\AiSensyWebApp\backend
npm run dev
```

**You should see:**
```
╔══════════════════════════════════════════════════════════╗
║                    🚀 SERVER STARTED!                     ║
╚══════════════════════════════════════════════════════════╝
```

---

### 2. Keep Terminal Open
**IMPORTANT:** Keep the terminal window open where server is running.
**This is where logs will appear!**

---

### 3. Make Request in Postman

**Example:**
- Method: `POST`
- URL: `http://localhost:5000/api/auth/register`
- Headers: `Content-Type: application/json`
- Body (raw, JSON):
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

---

### 4. Look at Terminal

**You should IMMEDIATELY see:**
```
╔══════════════════════════════════════════════════════════╗
║              🌐 NEW REQUEST RECEIVED                     ║
╠══════════════════════════════════════════════════════════╣
║ Time:    10:30:45 AM                                     ║
║ Method:  POST                                            ║
║ URL:     /api/auth/register                              ║
║ Path:    /register                                       ║
║ Body:    {"name":"John Doe","email":"john@example.com"} ║
╚══════════════════════════════════════════════════════════╝
```

**Then you'll see:**
```
🔥 REGISTER ROUTE HIT!

████████████████████████████████████████████████████
███  REGISTER CONTROLLER FUNCTION CALLED!  ███
████████████████████████████████████████████████████
```

---

## 🎯 Quick Test

### Test 1: Simple GET
```
GET http://localhost:5000/test
```
**Terminal should show:** Request received immediately

### Test 2: POST with Body
```
POST http://localhost:5000/test-body
Body: {"test": "hello"}
```
**Terminal should show:** Request + Body

### Test 3: Register
```
POST http://localhost:5000/api/auth/register
Body: {"name": "Test", "email": "test@test.com", "password": "test123"}
```
**Terminal should show:** Full request flow

---

## ❌ If You Don't See Logs

### Check 1: Is Server Running?
**Look for:** `🚀 SERVER STARTED` message
**If not:** Start server with `npm run dev`

### Check 2: Right Terminal?
**Make sure:** You're looking at the terminal where you ran `npm run dev`
**Not:** A different terminal window

### Check 3: Request Actually Sent?
**In Postman:** Click "Send" button
**Check:** Status shows "Sending..." then a response

### Check 4: Terminal Scrolled?
**Scroll:** Terminal to bottom
**Or:** Clear terminal and try again

---

## 💡 Pro Tip

**Keep two windows open:**
1. **Terminal** - See logs
2. **Postman** - Make requests

**Watch terminal while clicking "Send" in Postman!**

---

## ✅ What You Should See

**When you click "Send" in Postman, terminal should IMMEDIATELY show:**
- Request received message
- Method and URL
- Request body
- Route hit message
- Controller called message
- All processing logs

**All in real-time!** 🎉

