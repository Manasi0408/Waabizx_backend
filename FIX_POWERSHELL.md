# 🔧 Fix PowerShell Execution Policy Error

## Problem
PowerShell is blocking npm scripts because execution policy is too restrictive.

## Solution (Choose One)

### Option 1: Change Execution Policy (Recommended)

**Run PowerShell as Administrator:**

1. Right-click on PowerShell → "Run as Administrator"
2. Run this command:
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```
3. Type `Y` when prompted
4. Now you can run `npm run dev`

---

### Option 2: Bypass for Current Session Only

**In your current PowerShell window:**
```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
```
Then run `npm run dev`

**Note:** This only works for the current PowerShell session.

---

### Option 3: Use Command Prompt (CMD) Instead

**Open CMD (Command Prompt) instead of PowerShell:**
1. Press `Win + R`
2. Type `cmd` and press Enter
3. Navigate to your project:
```cmd
cd D:\AiSensyWebApp\backend
```
4. Run:
```cmd
npm run dev
```

CMD doesn't have execution policy restrictions.

---

### Option 4: Use Git Bash

If you have Git installed:
1. Open Git Bash
2. Navigate to project:
```bash
cd /d/AiSensyWebApp/backend
```
3. Run:
```bash
npm run dev
```

---

## Quick Fix (Easiest)

**Just use CMD instead of PowerShell:**
- CMD works the same way
- No execution policy issues
- All npm commands work normally

---

## After Fixing

Once you can run npm commands, start your server:
```bash
cd D:\AiSensyWebApp\backend
npm run dev
```

