# 📋 How to View Logs

## Console Logs (Terminal/CMD Window)

**Console logs show in the window where you started the server.**

When you run `npm run dev`, you should see:
- Server startup messages
- Database connection messages
- Request logs (when you hit APIs)
- Error messages

**If you don't see logs:**
- Make sure server is running
- Check the CMD/terminal window where you started it
- Look for the console.log output

---

## File Logs

### Location
- `backend/logs/app.log` - General logs
- `backend/logs/error.log` - Error logs

### How to View

**Option 1: Open in Notepad**
1. Go to: `D:\AiSensyWebApp\backend\logs\`
2. Open `app.log` or `error.log` in Notepad

**Option 2: PowerShell**
```powershell
Get-Content backend\logs\app.log -Tail 20
Get-Content backend\logs\error.log -Tail 20
```

**Option 3: CMD**
```cmd
type backend\logs\app.log
type backend\logs\error.log
```

**Option 4: Watch in Real-Time (PowerShell)**
```powershell
Get-Content backend\logs\app.log -Wait -Tail 10
```
This shows new logs as they appear!

---

## What Gets Logged

### Console Logs (Always Visible)
- Server startup
- Database connection
- Request details (from controllers)
- Errors

### File Logs (app.log)
- Request bodies
- General application logs
- Timestamped entries

### File Logs (error.log)
- Error messages
- Stack traces
- Database errors

---

## If Logs Are Empty

**Logs are created when:**
1. You make API requests
2. Errors occur
3. Logger is called

**If logs folder is empty:**
- Make a test API request
- Check if server is running
- Verify logger is being called

---

## Quick Test

**Make a request to:**
```
POST http://localhost:5000/api/auth/debug
```

**Then check:**
- Console window (should show logs)
- `backend/logs/app.log` (should have entry)

---

## Troubleshooting

**If console logs don't show:**
- Server might not be running
- Check the terminal window
- Restart server

**If file logs don't exist:**
- Make an API request first
- Check folder permissions
- Verify logger is working

