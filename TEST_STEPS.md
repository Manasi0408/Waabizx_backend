# 🧪 Test Steps to Fix 400 Error

## Step 1: Test Basic Endpoint (No Body)

**GET** `http://localhost:5000/test`

**Expected:** Should return success
**If this fails:** Server is not running or routes not set up

---

## Step 2: Test Body Parser

**POST** `http://localhost:5000/test-body`
**Headers:** `Content-Type: application/json`
**Body (raw, JSON):**
```json
{
  "test": "data"
}
```

**Expected:** Should show the body you sent
**If this fails:** Body parser is not working

---

## Step 3: Test Auth Debug Endpoint

**POST** `http://localhost:5000/api/auth/debug`
**Headers:** `Content-Type: application/json`
**Body (raw, JSON):**
```json
{
  "name": "Test",
  "email": "test@test.com",
  "password": "test123"
}
```

**Expected:** Should show what server received
**If this fails:** Route or body parser issue

---

## Step 4: Test Register

**POST** `http://localhost:5000/api/auth/register`
**Headers:** `Content-Type: application/json`
**Body (raw, JSON):**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

**Expected:** Should create user or show specific error
**If this fails:** Check server console for detailed logs

---

## 🔍 What to Check

1. **Server Console:** Look for error messages
2. **Postman Response:** Copy the exact error message
3. **Log Files:** Check `backend/logs/error.log`

---

## ✅ If All Tests Pass

Your setup is working! The issue might be:
- Wrong JSON format in Postman
- Missing Content-Type header
- Invalid data in request

---

## ❌ If Tests Fail

Share:
1. Which test failed
2. Error message from Postman
3. Server console output

