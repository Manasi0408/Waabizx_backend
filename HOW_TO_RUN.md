# 🚀 How to Run Backend Server

## Quick Start Commands

### Option 1: Development Mode (Auto-restart on changes)
```bash
npm run dev
```

**This uses nodemon** - server automatically restarts when you change files.

---

### Option 2: Production Mode
```bash
npm start
```

**This runs normally** - no auto-restart.

---

### Option 3: Direct Node Command
```bash
node server.js
```

**Runs server directly** without npm scripts.

---

## Step-by-Step Instructions

### Using Command Prompt (CMD) - Recommended

1. **Open Command Prompt:**
   - Press `Windows Key + R`
   - Type: `cmd`
   - Press Enter

2. **Navigate to backend folder:**
   ```cmd
   cd D:\AiSensyWebApp\backend
   ```

3. **Run the server:**
   ```cmd
   npm run dev
   ```

4. **You should see:**
   ```
   🚀 Server running on port 5000
   📡 API available at: http://localhost:5000
   ✅ Database connected
   ```

---

### Using PowerShell

**If PowerShell works:**
```powershell
cd D:\AiSensyWebApp\backend
npm run dev
```

**If you get execution policy error, use:**
```powershell
cd D:\AiSensyWebApp\backend
npm.cmd run dev
```

---

### Using Batch File (Easiest!)

**Just double-click:**
- `START_SERVER_DEV.bat` - Development mode (auto-restart)
- `START_SERVER.bat` - Normal mode

**No need to open terminal!**

---

## What Each Command Does

| Command | What It Does |
|---------|--------------|
| `npm run dev` | Starts with nodemon (auto-restart) |
| `npm start` | Starts normally (no auto-restart) |
| `node server.js` | Runs directly (no auto-restart) |

---

## After Starting

**Server will be available at:**
- Main API: `http://localhost:5000`
- Health Check: `http://localhost:5000/health`
- Test: `http://localhost:5000/test`

**To stop server:**
- Press `Ctrl + C` in the terminal

---

## Troubleshooting

**If npm doesn't work:**
- Use `npm.cmd` instead
- Or use the batch file
- Or use CMD instead of PowerShell

**If port 5000 is busy:**
- Change PORT in `.env` file
- Or stop other services using port 5000

---

## Recommended Command

**For development, always use:**
```bash
npm run dev
```

This gives you:
- ✅ Auto-restart on file changes
- ✅ Better error messages
- ✅ Development mode features

