require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection(config, label) {
  try {
    const connection = await mysql.createConnection(config);
    await connection.end();
    return { success: true, label };
  } catch (error) {
    return { success: false, label, error: error.message };
  }
}

async function setupDatabase() {
  console.log('🔌 MySQL Database Setup & Connection Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'aisensy_db';
  
  console.log('📋 Current Configuration:');
  console.log(`   Host: ${host}`);
  console.log(`   User: ${user}`);
  console.log(`   Password: ${password ? '***SET***' : 'NOT SET (will try empty)'}`);
  console.log(`   Database: ${dbName}\n`);
  
  // Try different connection scenarios
  const scenarios = [];
  
  // Scenario 1: With password from .env
  if (password) {
    scenarios.push({
      config: { host, user, password },
      label: 'With password from .env'
    });
  }
  
  // Scenario 2: Without password (empty)
  scenarios.push({
    config: { host, user, password: '' },
    label: 'Without password (empty)'
  });
  
  // Scenario 3: Without password field
  scenarios.push({
    config: { host, user },
    label: 'Without password field'
  });
  
  console.log('🧪 Testing connection scenarios...\n');
  
  let successfulConnection = null;
  
  for (const scenario of scenarios) {
    const result = await testConnection(scenario.config, scenario.label);
    if (result.success) {
      console.log(`✅ ${scenario.label}: SUCCESS`);
      successfulConnection = scenario.config;
      break;
    } else {
      console.log(`❌ ${scenario.label}: FAILED - ${result.error}`);
    }
  }
  
  if (!successfulConnection) {
    console.log('\n❌ All connection attempts failed!\n');
    console.log('📝 Troubleshooting Guide:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('1. ✅ Check if MySQL is running:');
    console.log('   - Windows: Open Services → Find MySQL → Start if stopped');
    console.log('   - Or use XAMPP/WAMP control panel');
    console.log('\n2. 🔐 Verify MySQL credentials:');
    console.log('   - Open MySQL command line or phpMyAdmin');
    console.log('   - Try: mysql -u root -p');
    console.log('   - Enter your password when prompted');
    console.log('\n3. 📝 Update .env file:');
    console.log('   - If password works manually, copy exact password to .env');
    console.log('   - If no password, set: DB_PASSWORD=');
    console.log('   - For special characters, you may need quotes: DB_PASSWORD="Root@123"');
    console.log('\n4. 🔄 Common solutions:');
    console.log('   - XAMPP default: Usually no password (DB_PASSWORD=)');
    console.log('   - WAMP default: Usually no password (DB_PASSWORD=)');
    console.log('   - Standalone MySQL: Check your installation password');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  }
  
  // If we got here, connection works - create database
  try {
    console.log(`\n📦 Creating database '${dbName}'...`);
    const connection = await mysql.createConnection(successfulConnection);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.end();
    console.log(`✅ Database '${dbName}' created/verified successfully!`);
    
    // Update .env recommendation if password was different
    if (password && !successfulConnection.password) {
      console.log('\n💡 Recommendation:');
      console.log('   Your .env has a password, but MySQL works without one.');
      console.log('   Consider setting DB_PASSWORD= in your .env file.');
    } else if (!password && successfulConnection.password) {
      console.log('\n💡 Recommendation:');
      console.log('   MySQL requires a password. Update your .env with:');
      console.log('   DB_PASSWORD=your_actual_password');
    }
    
    console.log('\n✅ Setup complete! You can now start your server with: npm run dev\n');
    
  } catch (error) {
    console.error('\n❌ Error creating database:', error.message);
    process.exit(1);
  }
}

setupDatabase();

