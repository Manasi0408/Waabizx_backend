# Quick Fix Checklist for 400 Error

## ✅ Follow These Steps in Order

### 1. Check Postman Setup (Most Common Issue!)

**In Postman:**
- [ ] Method is `POST` (not GET)
- [ ] URL is: `http://localhost:5000/api/auth/register`
- [ ] Headers tab has: `Content-Type: application/json`
- [ ] Body tab: Selected `raw` (not form-data)
- [ ] Body tab: Dropdown shows `JSON` (not Text)
- [ ] Body contains this EXACT format:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

### 2. Check Server Console

**Look at your CMD/terminal where server is running:**

You should see when you make a request:
```
=== REGISTER REQUEST ===
Method: POST
Path: /api/auth/register
Body: { "name": "John Doe", "email": "john@example.com", "password": "password123" }
```

**If you see `Body: {}` or `Body: undefined`:**
→ Your request body is not being sent correctly
→ Go back to Step 1 and check Postman setup

### 3. Check the Error Response

**In Postman, look at the response body:**

If you see:
```json
{
  "success": false,
  "message": "Missing required fields: name, email, password",
  "received": {
    "name": null,
    "email": null,
    "password": null
  }
}
```

**This means:** The server is not receiving your data
**Fix:** Check Step 1 - Postman setup

### 4. Check Log Files

**Open these files:**
- `backend\logs\app.log` - See what the server received
- `backend\logs\error.log` - See any errors

**Quick way to view:**
1. Open File Explorer
2. Go to: `D:\AiSensyWebApp\backend\logs\`
3. Open `app.log` in Notepad
4. Scroll to the bottom to see latest entries

### 5. Test Route First

**Before testing register, test this:**

GET `http://localhost:5000/api/auth/test`

**If this works:** Routes are fine, issue is with your request
**If this doesn't work:** Server might not be running or routes not set up

---

## 🎯 Most Likely Issues

### Issue #1: Wrong Body Format in Postman
**Symptom:** Server shows `Body: {}`
**Fix:** 
- Body tab → Select `raw`
- Dropdown → Select `JSON`
- Add Content-Type header

### Issue #2: Missing Fields
**Symptom:** Error says "Missing required fields"
**Fix:** Make sure JSON has all three: name, email, password

### Issue #3: Invalid Email
**Symptom:** Error says "Please provide a valid email address"
**Fix:** Use format: `something@example.com`

### Issue #4: Password Too Short
**Symptom:** Error says "Password must be at least 6 characters"
**Fix:** Use password with 6+ characters

---

## 📸 What to Check

After making a request, check:

1. **Postman Response Tab:**
   - What error message do you see?
   - What status code? (should show 400)

2. **Server Console:**
   - Do you see the "=== REGISTER REQUEST ===" log?
   - What does "Body:" show?

3. **Log Files:**
   - Open `backend\logs\app.log`
   - What's the last entry?

---

## 🆘 Still Stuck?

Share these 3 things:

1. **Screenshot of Postman:**
   - Headers tab
   - Body tab (showing your JSON)

2. **Server Console Output:**
   - Copy the "=== REGISTER REQUEST ===" section

3. **Postman Response:**
   - Copy the entire error response

