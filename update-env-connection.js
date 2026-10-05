require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function updateAndTestConnection() {
  try {
    const envPath = path.join(__dirname, '.env');
    
    // Read current .env
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    console.log('🔍 Current .env Configuration:\n');
    console.log(envContent);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Extract current values
    const host = process.env.DB_HOST || 'localhost';
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASSWORD || '';
    const dbName = process.env.DB_NAME || 'aisensy_db';
    const port = process.env.DB_PORT || 3306;

    console.log('🧪 Testing connection to MySQL Community Server...\n');
    console.log('Connection Details:');
    console.log(`  Host: ${host}`);
    console.log(`  Port: ${port}`);
    console.log(`  User: ${user}`);
    console.log(`  Password: ${password ? '***SET***' : 'NOT SET'}`);
    console.log(`  Database: ${dbName}\n`);

    // Test connection
    let connection;
    try {
      connection = await mysql.createConnection({
        host,
        port,
        user,
        password: password || undefined
      });
      console.log('✅ Successfully connected to MySQL Community Server!\n');
    } catch (err) {
      console.error('❌ Connection failed:', err.message);
      console.error('\n💡 Please verify:');
      console.error('   1. MySQL Community Server is running');
      console.error('   2. The password in .env matches your MySQL password');
      console.error('   3. You can connect manually: mysql -u root -p');
      process.exit(1);
    }

    // Check if database exists
    const [databases] = await connection.query('SHOW DATABASES');
    const dbExists = databases.some(db => db.Database === dbName);

    if (dbExists) {
      console.log(`✅ Database '${dbName}' exists!\n`);
      
      // Try to use it
      await connection.query(`USE \`${dbName}\``);
      console.log(`✅ Successfully connected to database '${dbName}'\n`);
      
      // Show tables
      const [tables] = await connection.query('SHOW TABLES');
      if (tables.length > 0) {
        console.log('📊 Existing Tables:');
        tables.forEach(table => {
          const tableName = Object.values(table)[0];
          console.log(`  - ${tableName}`);
        });
      } else {
        console.log('⚠️  No tables found (will be created when server starts)\n');
      }
    } else {
      console.log(`❌ Database '${dbName}' not found!\n`);
      console.log(`📦 Creating database '${dbName}'...`);
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      console.log(`✅ Database '${dbName}' created successfully!\n`);
    }

    await connection.end();

    // Verify .env is correct
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Configuration Verified!\n');
    console.log('📝 Your .env file is correctly configured for MySQL Community Server:');
    console.log(`   DB_HOST=${host}`);
    console.log(`   DB_USER=${user}`);
    console.log(`   DB_PASSWORD=${password ? '***SET***' : 'NOT SET'}`);
    console.log(`   DB_NAME=${dbName}`);
    console.log(`   DB_PORT=${port}`);
    console.log('\n✅ Backend is ready to connect to MySQL Community Server!');
    console.log('🚀 Start your server with: npm run dev');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

updateAndTestConnection();

