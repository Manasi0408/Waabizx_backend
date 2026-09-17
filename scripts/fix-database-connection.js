require('dotenv').config();
const mysql = require('mysql2/promise');

console.log('\n🔧 DATABASE CONNECTION FIXER\n');
console.log('='.repeat(60));

const testConnection = async (config, label) => {
  try {
    const connection = await mysql.createConnection(config);
    await connection.ping();
    await connection.end();
    console.log(`✅ ${label}: SUCCESS!`);
    return true;
  } catch (error) {
    console.log(`❌ ${label}: ${error.message}`);
    return false;
  }
};

const main = async () => {
  const dbName = process.env.DB_NAME || 'aisensy_db';
  const dbUser = process.env.DB_USER || 'root';
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = process.env.DB_PORT || 3306;
  const dbPassword = process.env.DB_PASSWORD || '';

  console.log('\n📋 Current Configuration:');
  console.log(`   Host: ${dbHost}`);
  console.log(`   Port: ${dbPort}`);
  console.log(`   User: ${dbUser}`);
  console.log(`   Database: ${dbName}`);
  console.log(`   Password: ${dbPassword ? '***SET*** (' + dbPassword.length + ' chars)' : 'NOT SET'}`);
  console.log('\n🧪 Testing Connections...\n');

  // Test 1: With password from .env
  if (dbPassword) {
    await testConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword
    }, 'Test 1: With password from .env');
  }

  // Test 2: Without password
  await testConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser
  }, 'Test 2: Without password (empty)');

  // Test 3: Common passwords
  const commonPasswords = ['', 'root', 'Root@123', 'root123', 'password', '123456'];
  for (const pwd of commonPasswords) {
    if (pwd !== dbPassword) {
      await testConnection({
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: pwd
      }, `Test: Password "${pwd || '(empty)'}"`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n💡 SOLUTIONS:\n');
  console.log('1. If "Without password" worked:');
  console.log('   → Set DB_PASSWORD= in .env (empty)');
  console.log('\n2. If one of the tests worked:');
  console.log('   → Update .env with that password');
  console.log('\n3. If ALL failed:');
  console.log('   → MySQL might not be running');
  console.log('   → Run: net start MySQL (or check MySQL service)');
  console.log('   → Or: mysql -u root -p (test manually)');
  console.log('\n4. Create new MySQL user:');
  console.log('   → mysql -u root -p');
  console.log('   → CREATE USER \'aisensy_user\'@\'localhost\' IDENTIFIED BY \'simple123\';');
  console.log('   → GRANT ALL PRIVILEGES ON aisensy_db.* TO \'aisensy_user\'@\'localhost\';');
  console.log('   → FLUSH PRIVILEGES;');
  console.log('   → Update .env: DB_USER=aisensy_user, DB_PASSWORD=simple123');
  console.log('\n');
};

main().catch(console.error);

