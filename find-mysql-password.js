require('dotenv').config();
const mysql = require('mysql2/promise');

async function findCorrectPassword() {
  console.log('🔍 Finding Correct MySQL Password for Community Server...\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const host = 'localhost';
  const user = 'root';
  const dbName = 'aisensy_db';

  // Common passwords to try
  const passwordsToTry = [
    '', // Empty password
    'Root@123', // Current .env password
    'root',
    'Root',
    'password',
    'Password',
    '123456',
    'root123',
    'Root123',
  ];

  console.log('🧪 Testing different password scenarios...\n');

  let successfulPassword = null;
  let successfulConnection = null;

  for (const password of passwordsToTry) {
    try {
      const connection = await mysql.createConnection({
        host,
        user,
        password: password || undefined
      });
      
      console.log(`✅ SUCCESS with password: ${password || '(empty)'}`);
      successfulPassword = password;
      successfulConnection = connection;
      break;
    } catch (err) {
      console.log(`❌ Failed with password: ${password || '(empty)'}`);
    }
  }

  if (!successfulConnection) {
    console.log('\n❌ None of the common passwords worked!\n');
    console.log('💡 Please enter your MySQL password manually:');
    console.log('   1. Open MySQL command line');
    console.log('   2. Connect: mysql -u root -p');
    console.log('   3. Enter your password when prompted');
    console.log('   4. If it works, update .env with that exact password');
    console.log('\n📝 Update .env file:');
    console.log('   DB_PASSWORD=your_actual_password');
    console.log('\n⚠️  If password has special characters, use quotes:');
    console.log('   DB_PASSWORD="Your@Password#123"');
    process.exit(1);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Found working password!\n');

  // Verify database exists
  try {
    const [databases] = await successfulConnection.query('SHOW DATABASES');
    const dbExists = databases.some(db => db.Database === dbName);

    if (!dbExists) {
      console.log(`📦 Creating database '${dbName}'...`);
      await successfulConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      console.log(`✅ Database '${dbName}' created!\n`);
    } else {
      console.log(`✅ Database '${dbName}' already exists!\n`);
    }
  } catch (err) {
    console.error('Error with database:', err.message);
  }

  await successfulConnection.end();

  // Update .env file
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');

  try {
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // Update DB_PASSWORD line
    if (envContent.includes('DB_PASSWORD=')) {
      if (successfulPassword) {
        // Check if password has special characters that need quotes
        const needsQuotes = /[@#\$%^&*()+\-=\[\]{};':"\\|,.<>\/?]/.test(successfulPassword);
        const passwordValue = needsQuotes ? `"${successfulPassword}"` : successfulPassword;
        envContent = envContent.replace(/DB_PASSWORD=.*/g, `DB_PASSWORD=${passwordValue}`);
      } else {
        envContent = envContent.replace(/DB_PASSWORD=.*/g, 'DB_PASSWORD=');
      }
    } else {
      // Add DB_PASSWORD if it doesn't exist
      const passwordValue = successfulPassword ? (successfulPassword.includes('@') ? `"${successfulPassword}"` : successfulPassword) : '';
      envContent += `\nDB_PASSWORD=${passwordValue}`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log('✅ Updated .env file with correct password!\n');
  } catch (err) {
    console.error('⚠️  Could not update .env file automatically:', err.message);
    console.log('\n📝 Please manually update .env file:');
    if (successfulPassword) {
      const needsQuotes = /[@#\$%^&*()+\-=\[\]{};':"\\|,.<>\/?]/.test(successfulPassword);
      console.log(`   DB_PASSWORD=${needsQuotes ? `"${successfulPassword}"` : successfulPassword}`);
    } else {
      console.log('   DB_PASSWORD=');
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Configuration Complete!\n');
  console.log('📋 Summary:');
  console.log(`   Host: ${host}`);
  console.log(`   User: ${user}`);
  console.log(`   Password: ${successfulPassword || '(empty)'}`);
  console.log(`   Database: ${dbName}\n`);
  console.log('🚀 Your backend is now configured for MySQL Community Server!');
  console.log('   Start server with: npm run dev');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

findCorrectPassword();

