// Test MySQL password
// Run: node scripts/test-mysql-password.js

require('dotenv').config();
const mysql = require('mysql2/promise');

async function testPassword() {
  const passwordsToTest = [
    process.env.DB_PASSWORD, // From .env
    process.env.DB_PASSWORD?.replace(/^["']|["']$/g, ''), // Cleaned
    'Root@123',
    'root@123',
    'root',
    '', // Empty
  ].filter(Boolean); // Remove duplicates and empty

  const uniquePasswords = [...new Set(passwordsToTest)];

  console.log('🧪 Testing MySQL Passwords...\n');
  console.log('Testing passwords:', uniquePasswords.map(p => p ? '***' : '(empty)').join(', '));
  console.log('');

  for (const password of uniquePasswords) {
    try {
      console.log(`Testing password: ${password ? '***' : '(empty)'}...`);
      
      const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: password
      });

      await connection.query('SELECT 1');
      await connection.end();

      console.log(`✅ SUCCESS! Password works: ${password ? '***' : '(empty)'}`);
      console.log(`\n💡 Update your .env file:`);
      if (password) {
        console.log(`   DB_PASSWORD="${password}"`);
      } else {
        console.log(`   DB_PASSWORD=`);
      }
      console.log(`\nThen restart your server.\n`);
      process.exit(0);
      
    } catch (error) {
      if (error.code === 'ER_ACCESS_DENIED_ERROR') {
        console.log(`   ❌ Wrong password\n`);
      } else {
        console.log(`   ❌ Error: ${error.message}\n`);
      }
    }
  }

  console.log('❌ None of the passwords worked!');
  console.log('\n💡 Solutions:');
  console.log('1. Check your MySQL root password');
  console.log('2. Try: mysql -u root -p (and enter your password)');
  console.log('3. If you forgot password, reset MySQL root password');
  console.log('4. Or create a new MySQL user with known password\n');
  process.exit(1);
}

testPassword();

