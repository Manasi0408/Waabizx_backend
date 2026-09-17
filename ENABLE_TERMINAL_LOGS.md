# 🔧 Enable Terminal Logs in Cursor

## Issue: Logs Not Showing in Cursor Terminal

If logs aren't displaying in Cursor terminal, try these solutions:

---

## Solution 1: Restart Server

**Stop the server (Ctrl+C) and restart:**
```bash
npm run dev
```

**Or use the batch file:**
- Double-click: `START_SERVER_DEV.bat`

---

## Solution 2: Check Terminal Output

**Make sure you're looking at the correct terminal:**
1. The terminal where you ran `npm run dev`
2. Check if server is actually running
3. Look for: `🚀 Server running on port 5000`

---

## Solution 3: Test with Simple Request

**Make a test request to see logs:**

1. **GET Request:**
   ```
   GET http://localhost:5000/test
   ```
   Should show in terminal immediately

2. **POST Request:**
   ```
   POST http://localhost:5000/test-body
   Headers: Content-Type: application/json
   Body: {"test": "data"}
   ```
   Should show detailed logs in terminal

---

## Solution 4: Use Integrated Terminal

**In Cursor:**
1. Press `` Ctrl + ` `` (backtick) to open terminal
2. Or: View → Terminal
3. Make sure terminal is visible
4. Run server in that terminal

---

## Solution 5: Check Terminal Settings

**In Cursor settings:**
- Make sure terminal output is enabled
- Check if terminal is scrolled to bottom
- Try clearing terminal and restarting

---

## Solution 6: Force Output

**I've added code to force immediate output:**
- Logs now use `console.log` (not buffered)
- Added visual separators for better visibility
- Added immediate flush commands

**Restart server to apply changes!**

---

## Quick Test

**After restarting server, test:**

1. **Simple GET:**
   ```
   GET http://localhost:5000/test
   ```
   Terminal should show: `📥 TEST REQUEST RECEIVED`

2. **POST with body:**
   ```
   POST http://localhost:5000/test-body
   Body: {"test": "hello"}
   ```
   Terminal should show detailed body info

---

## If Still Not Working

**Check:**
1. Is server actually running? (Look for startup message)
2. Are you making requests? (Logs only show on requests)
3. Is terminal scrolled to bottom?
4. Try a different terminal (CMD instead of PowerShell)

---

## What You Should See

**On server start:**
```
🚀 Server running on port 5000
📡 API available at: http://localhost:5000
✅ Database connected
```

**On API request:**
```
==================================================
📥 REGISTER REQUEST RECEIVED
==================================================
Method: POST
Body: { ... }
==================================================
```

