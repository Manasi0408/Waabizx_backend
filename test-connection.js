require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    console.log('🔌 Testing MySQL Connection...\n');
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
    
    // Show tables
    const [tables] = await connection.query('SHOW TABLES');
    if (tables.length > 0) {
      console.log('\n📊 Tables found:');
      tables.forEach(table => {
        const tableName = Object.values(table)[0];
        console.log(`  - ${tableName}`);
      });
    } else {
      console.log('\n⚠️  No tables found (will be created when server starts)');
    }
    
    await connection.end();
    console.log('\n✅ Backend can connect to MySQL!');
    console.log('🚀 You can now start your server with: npm run dev');
    
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Check MySQL is running');
    console.error('   2. Verify password in .env matches MySQL password');
    console.error('   3. Make sure database exists');
    console.error('   4. Check host and port are correct');
    console.error('\n📝 Run diagnostics: node diagnose-connection.js');
    process.exit(1);
  }
}

testConnection();

