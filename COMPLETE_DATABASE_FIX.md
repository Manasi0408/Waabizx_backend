# 🔧 COMPLETE DATABASE FIX - Step by Step

## 🚨 Current Issue
Database connection keeps failing with "Access denied" error.

---

## ✅ SOLUTION - Follow These Steps

### Step 1: Check if MySQL is Running

**Open PowerShell and run:**
```powershell
Get-Service | Where-Object {$_.Name -like "*mysql*"}
```

**If MySQL is NOT running:**
- **XAMPP**: Open XAMPP Control Panel → Start MySQL
- **WAMP**: Open WAMP Control Panel → Start MySQL  
- **Standalone**: Open Services (Win+R → services.msc) → Find MySQL → Start

---

### Step 2: Test Database Connection

**Run this command:**
```bash
cd D:\AiSensyWebApp\backend
npm run fix-db
```

**This will:**
- Test multiple password combinations
- Tell you which one works
- Give you exact steps to fix

---

### Step 3: Fix Based on Results

#### If "Without password" worked:
**Update `.env`:**
```env
DB_PASSWORD=
```
(Just leave it empty or remove the line)

#### If a specific password worked:
**Update `.env` with that password:**
```env
DB_PASSWORD=the_password_that_worked
```

---

### Step 4: Create New MySQL User (If Root Doesn't Work)

**Open MySQL command line:**
```bash
mysql -u root -p
```
(Enter your root password, or press Enter if no password)

**Then run these SQL commands:**
```sql
CREATE USER 'aisensy_user'@'localhost' IDENTIFIED BY 'simple123';
GRANT ALL PRIVILEGES ON aisensy_db.* TO 'aisensy_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

**Update `.env`:**
```env
DB_USER=aisensy_user
DB_PASSWORD=simple123
```

---

### Step 5: Restart Server

```bash
npm run dev
```

---

## 🆘 If Still Not Working

### Option A: Skip Database for Now

**Server will run without database!**

Just start server:
```bash
npm run dev
```

**You'll see:**
```
⚠️  Database connection failed - Server will continue without database
🚀 Server running on port 5000
```

**You can still:**
- ✅ Test APIs
- ✅ See all logs
- ✅ Test routes
- ❌ Database operations will fail (but that's OK for testing)

---

### Option B: Use SQLite Instead (No MySQL Needed)

I can help you switch to SQLite which doesn't need MySQL setup.

---

## 📋 Quick Checklist

- [ ] MySQL service is running
- [ ] Ran `npm run fix-db` to test connections
- [ ] Updated `.env` with correct password (or empty)
- [ ] Restarted server with `npm run dev`
- [ ] Checked terminal for connection status

---

## 🎯 Most Common Solutions

1. **XAMPP/WAMP**: Usually no password → `DB_PASSWORD=`
2. **Standalone MySQL**: Check installation password
3. **Forgot password**: Create new user (see Step 4)

---

**Run `npm run fix-db` first - it will tell you exactly what to do!**

