# Complete Guide: Connect Backend to MySQL Database

## Step-by-Step Instructions

### Step 1: Verify MySQL is Running

**Check if MySQL service is running:**

1. Open **Services** (Press `Win + R`, type `services.msc`, press Enter)
2. Look for **MySQL** or **MySQL80** service
3. Make sure it's **Running** (if not, right-click → Start)

**OR**

1. Open **Command Prompt** or **PowerShell**
2. Run: `mysql --version`
   - If you see version info, MySQL is installed
   - If error, MySQL is not in PATH

### Step 2: Connect to MySQL Command Line

**Option A: If MySQL is in PATH**
```bash
mysql -u root -p
```
- Enter your password when prompted
- If no password, just press Enter

**Option B: If MySQL is NOT in PATH (MySQL Community Server)**
```bash
# Navigate to MySQL bin directory
cd C:\Program Files\MySQL\MySQL Server 8.0\bin

# Connect
mysql.exe -u root -p
```

**Option C: Find MySQL installation**
```bash
# In PowerShell
where.exe mysql

# This will show the path, then navigate there
```

### Step 3: Verify Database Exists

Once connected to MySQL, run:

```sql
-- Show all databases
SHOW DATABASES;

-- You should see 'aisensy_db' in the list
-- If not, create it:
CREATE DATABASE IF NOT EXISTS aisensy_db;

-- Use the database
USE aisensy_db;

-- Show tables (will be empty initially)
SHOW TABLES;
```

### Step 4: Check Your MySQL Credentials

**In MySQL command line, run:**
```sql
-- Check current user
SELECT USER();

-- Check host
SELECT @@hostname;

-- Check port
SELECT @@port;
```

**Note these values:**
- User: Usually `root@localhost`
- Host: Usually `localhost` or your computer name
- Port: Usually `3306`

### Step 5: Configure Backend .env File

**Location:** `backend/.env`

**Edit the file with these values:**

```env
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=aisensy_db
DB_PORT=3306
JWT_SECRET=aisensy_secret_key
JWT_EXPIRE=30d
```

**Important Password Rules:**

1. **If NO password:**
   ```env
   DB_PASSWORD=
   ```
   (Leave empty after the equals sign)

2. **If you have a password:**
   ```env
   DB_PASSWORD=your_password
   ```

3. **If password has special characters (@, #, $, etc.):**
   ```env
   DB_PASSWORD="Root@123"
   ```
   (Use double quotes)

### Step 6: Test Backend Connection

**Create a test script:**

Create file: `backend/test-connection.js`

```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    console.log('Testing MySQL Connection...\n');
    console.log('Configuration:');
    console.log(`  Host: ${process.env.DB_HOST || 'localhost'}`);
    console.log(`  User: ${process.env.DB_USER || 'root'}`);
    console.log(`  Password: ${process.env.DB_PASSWORD ? '***SET***' : '(empty)'}`);
    console.log(`  Database: ${process.env.DB_NAME || 'aisensy_db'}\n`);

    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || undefined,
      database: process.env.DB_NAME || 'aisensy_db'
    });

    console.log('✅ Connection successful!');
    
    const [rows] = await connection.query('SELECT DATABASE() as db');
    console.log(`✅ Connected to database: ${rows[0].db}`);
    
    await connection.end();
    console.log('\n✅ Backend can connect to MySQL!');
    
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Check MySQL is running');
    console.error('   2. Verify password in .env matches MySQL password');
    console.error('   3. Make sure database exists');
    console.error('   4. Check host and port are correct');
    process.exit(1);
  }
}

testConnection();
```

**Run the test:**
```bash
cd backend
node test-connection.js
```

### Step 7: Common Issues and Solutions

#### Issue 1: "Access denied for user 'root'@'localhost'"

**Solution:**
- Password in `.env` doesn't match MySQL password
- Test password manually:
  ```bash
  mysql -u root -p
  ```
- If it works, copy the exact password to `.env`

#### Issue 2: "Unknown database 'aisensy_db'"

**Solution:**
- Database doesn't exist
- Create it in MySQL:
  ```sql
  CREATE DATABASE aisensy_db;
  ```

#### Issue 3: "Can't connect to MySQL server"

**Solution:**
- MySQL service is not running
- Start MySQL service from Services
- Or check firewall blocking port 3306

#### Issue 4: "mysql: command not found"

**Solution:**
- MySQL is not in PATH
- Use full path: `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe -u root -p`

### Step 8: Verify Complete Setup

**1. Test MySQL connection:**
```bash
mysql -u root -p
```

**2. In MySQL, verify database:**
```sql
SHOW DATABASES;
USE aisensy_db;
SHOW TABLES;
```

**3. Test backend connection:**
```bash
cd backend
node test-connection.js
```

**4. Start backend server:**
```bash
npm run dev
```

**5. Check server logs:**
- Should see: "Database connected"
- Should see: "Server running on port 5000"

### Step 9: Quick Verification Checklist

- [ ] MySQL service is running
- [ ] Can connect via `mysql -u root -p`
- [ ] Database `aisensy_db` exists
- [ ] `.env` file has correct credentials
- [ ] `node test-connection.js` succeeds
- [ ] Backend server starts without errors

### Step 10: Still Having Issues?

**Run diagnostic script:**

Create `backend/diagnose-connection.js`:

```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

async function diagnose() {
  console.log('🔍 MySQL Connection Diagnostics\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const config = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'aisensy_db',
    port: process.env.DB_PORT || 3306
  };
  
  console.log('Configuration from .env:');
  console.log(`  Host: ${config.host}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  User: ${config.user}`);
  console.log(`  Password: ${config.password ? '***SET***' : '(empty)'}`);
  console.log(`  Database: ${config.database}\n`);
  
  // Test 1: Connection without database
  console.log('Test 1: Connecting to MySQL server...');
  try {
    const conn1 = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password || undefined
    });
    console.log('✅ SUCCESS: Can connect to MySQL server\n');
    await conn1.end();
  } catch (err) {
    console.log('❌ FAILED:', err.message);
    console.log('\n💡 Fix: Check MySQL is running and credentials are correct\n');
    return;
  }
  
  // Test 2: Check database exists
  console.log('Test 2: Checking if database exists...');
  try {
    const conn2 = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password || undefined
    });
    const [dbs] = await conn2.query('SHOW DATABASES');
    const exists = dbs.some(db => db.Database === config.database);
    if (exists) {
      console.log(`✅ SUCCESS: Database '${config.database}' exists\n`);
    } else {
      console.log(`❌ FAILED: Database '${config.database}' does not exist`);
      console.log(`\n💡 Fix: Run: CREATE DATABASE ${config.database};\n`);
    }
    await conn2.end();
  } catch (err) {
    console.log('❌ FAILED:', err.message);
  }
  
  // Test 3: Connect to database
  console.log('Test 3: Connecting to database...');
  try {
    const conn3 = await mysql.createConnection(config);
    console.log(`✅ SUCCESS: Can connect to database '${config.database}'\n`);
    await conn3.end();
  } catch (err) {
    console.log('❌ FAILED:', err.message);
    console.log('\n💡 Fix: Check database name and permissions\n');
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

diagnose();
```

**Run diagnostics:**
```bash
cd backend
node diagnose-connection.js
```

This will tell you exactly what's wrong!

