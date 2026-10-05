require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function fixConnection() {
  console.log('🔧 Fixing Database Connection...\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const envPath = path.join(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');

  // Extract current password
  const passwordMatch = envContent.match(/DB_PASSWORD=(.*)/);
  const currentPassword = passwordMatch ? passwordMatch[1] : '';

  console.log('Current .env password:', `DB_PASSWORD=${currentPassword}\n`);

  const host = 'localhost';
  const user = 'root';
  const dbName = 'aisensy_db';

  // Test different password formats
  const passwordTests = [
    { value: '', label: 'Empty (no password)' },
    { value: currentPassword, label: 'Original from .env' },
    { value: currentPassword.replace(/^["']|["']$/g, ''), label: 'Without quotes' },
    { value: currentPassword.replace(/^["']|["']$/g, '').trim(), label: 'Without quotes, trimmed' },
    { value: 'Root@123', label: 'Root@123 (without quotes)' },
    { value: 'root', label: 'root' },
    { value: 'Root', label: 'Root' },
    { value: 'password', label: 'password' },
  ];

  console.log('🧪 Testing different password formats...\n');

  let workingPassword = null;
  let workingConnection = null;

  for (const test of passwordTests) {
    try {
      const connection = await mysql.createConnection({
        host,
        user,
        password: test.value || undefined
      });
      
      console.log(`✅ SUCCESS: ${test.label}`);
      workingPassword = test.value;
      workingConnection = connection;
      break;
    } catch (err) {
      console.log(`❌ FAILED: ${test.label}`);
    }
  }

  if (!workingConnection) {
    console.log('\n❌ None of the password formats worked!\n');
    console.log('💡 Please do the following:');
    console.log('   1. Open MySQL command line: mysql -u root -p');
    console.log('   2. Enter your password when prompted');
    console.log('   3. If it works, note the exact password');
    console.log('   4. Update .env file with that password');
    console.log('\n📝 In .env file:');
    console.log('   - If NO password: DB_PASSWORD=');
    console.log('   - If password: DB_PASSWORD=your_password');
    console.log('   - If special chars: DB_PASSWORD="Root@123"');
    process.exit(1);
  }

  console.log(`\n✅ Working password: ${workingPassword || '(empty)'}\n`);

  // Verify database
  try {
    const [databases] = await workingConnection.query('SHOW DATABASES');
    const dbExists = databases.some(db => db.Database === dbName);
    
    if (!dbExists) {
      console.log(`📦 Creating database '${dbName}'...`);
      await workingConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      console.log(`✅ Database '${dbName}' created!\n`);
    } else {
      await workingConnection.query(`USE \`${dbName}\``);
      console.log(`✅ Database '${dbName}' exists and accessible!\n`);
    }
  } catch (err) {
    console.error('❌ Database error:', err.message);
  }

  await workingConnection.end();

  // Update .env with working password
  let passwordValue;
  if (!workingPassword || workingPassword.trim() === '') {
    passwordValue = '';
  } else {
    // Check if password needs quotes
    const needsQuotes = /[@#\$%^&*()+\-=\[\]{};':"\\|,.<>\/? ]/.test(workingPassword);
    passwordValue = needsQuotes ? `"${workingPassword}"` : workingPassword;
  }

  // Update .env
  envContent = envContent.replace(/DB_PASSWORD=.*/g, `DB_PASSWORD=${passwordValue}`);
  fs.writeFileSync(envPath, envContent);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ .env file updated!\n');
  console.log(`📝 Updated: DB_PASSWORD=${passwordValue || '(empty)'}\n`);

  // Test with Sequelize
  console.log('🧪 Testing with Sequelize...\n');
  delete require.cache[require.resolve('./config/database')];
  const sequelize = require('./config/database');
  
  try {
    await sequelize.authenticate();
    console.log('✅ Sequelize connection successful!');
    
    const [result] = await sequelize.query('SELECT DATABASE() as db');
    console.log(`✅ Connected to: ${result[0].db}\n`);
    
    await sequelize.close();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Database connection is now working!');
    console.log('🚀 Start your server with: npm run dev');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (err) {
    console.error('❌ Sequelize test failed:', err.message);
    console.error('\n💡 The password works with mysql2 but Sequelize has an issue.');
    console.error('   Check database.js configuration.');
  }
}

fixConnection();

