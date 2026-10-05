# MySQL Connection Setup Guide

## Quick Fix Steps

### Step 1: Run the Setup Script
```bash
cd backend
npm run setup-db
```

This script will:
- Test different password scenarios
- Identify the correct connection method
- Create the database if it doesn't exist
- Provide specific recommendations

### Step 2: Common Solutions

#### Solution A: If MySQL has NO password (XAMPP/WAMP default)
Update your `.env` file:
```env
DB_PASSWORD=
```
Or remove the line entirely.

#### Solution B: If password has special characters
Try quoting the password in `.env`:
```env
DB_PASSWORD="Root@123"
```

#### Solution C: Verify your actual MySQL password
1. Open MySQL command line or phpMyAdmin
2. Try connecting: `mysql -u root -p`
3. Enter your password
4. If it works, use that exact password in `.env`

### Step 3: Check MySQL Service
- **Windows**: Open Services → Find "MySQL" → Start if stopped
- **XAMPP**: Start MySQL from XAMPP Control Panel
- **WAMP**: Start MySQL from WAMP Control Panel

### Step 4: Restart Server
After fixing `.env`:
```bash
npm run dev
```

## Error Messages Explained

- **"Access denied"**: Wrong password or user doesn't exist
- **"Connection refused"**: MySQL service is not running
- **"Database not found"**: Database doesn't exist (run `npm run setup-db`)

## Still Having Issues?

1. Check MySQL is running: `mysql -u root -p`
2. Verify credentials match your MySQL installation
3. Check firewall isn't blocking port 3306
4. Try creating a new MySQL user with proper permissions

