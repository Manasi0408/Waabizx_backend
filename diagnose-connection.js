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
      console.log(`\n💡 Fix: In MySQL, run: CREATE DATABASE ${config.database};\n`);
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

