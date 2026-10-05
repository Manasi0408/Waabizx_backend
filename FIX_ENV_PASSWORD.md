# 🔧 Fix .env Password Issue

## Problem

Your `.env` file has:
```env
DB_PASSWORD="Root@123"
```

**The quotes might be causing issues!**

---

## ✅ Solution: Remove Quotes from .env

### Option 1: Edit .env Manually

**Open `backend/.env` and change line 4 from:**
```env
DB_PASSWORD="Root@123"
```

**To (without quotes):**
```env
DB_PASSWORD=Root@123
```

**Save the file and restart server!**

---

### Option 2: Use This Command

**Run this in PowerShell:**
```powershell
cd D:\AiSensyWebApp\backend
(Get-Content .env) -replace 'DB_PASSWORD="Root@123"', 'DB_PASSWORD=Root@123' | Set-Content .env
```

**Then restart server:**
```bash
npm run dev
```

---

## 🧪 Test After Fix

**After removing quotes, restart server and check:**

1. **Server should show:**
   ```
   🔐 Database Config:
     Password: ***SET*** (9 chars)
   ```

2. **If still fails, try:**
   ```bash
   npm run test-password
   ```

---

## 💡 Why This Matters

- `.env` files: Quotes are usually NOT needed
- If you use quotes, dotenv includes them in the value
- My code removes quotes, but it's better to not have them

**Just remove the quotes from `.env` file!**

