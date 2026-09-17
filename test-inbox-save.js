/**
 * Test script to verify InboxMessage table and save functionality
 * Run: node test-inbox-save.js
 */

require('dotenv').config();
const { InboxMessage, Contact, User } = require('./models');

async function testInboxSave() {
  try {
    console.log('🔍 Testing InboxMessage save functionality...\n');

    // 1. Check if table exists
    console.log('1️⃣  Checking if inboxmessages table exists...');
    try {
      await InboxMessage.sync({ alter: false });
      console.log('✅ Table exists or was created\n');
    } catch (error) {
      console.error('❌ Error syncing table:', error.message);
      console.log('⚠️  Attempting to create table...');
      await InboxMessage.sync({ force: false, alter: true });
      console.log('✅ Table created\n');
    }

    // 2. Get a test user
    console.log('2️⃣  Finding test user...');
    const testUser = await User.findOne({ order: [['id', 'ASC']] });
    if (!testUser) {
      console.error('❌ No users found in database. Please create a user first.');
      process.exit(1);
    }
    console.log(`✅ Found user: ID=${testUser.id}, Email=${testUser.email}\n`);

    // 3. Get or create a test contact
    console.log('3️⃣  Finding or creating test contact...');
    let testContact = await Contact.findOne({
      where: { userId: testUser.id },
      order: [['id', 'ASC']]
    });

    if (!testContact) {
      console.log('⚠️  No contact found, creating test contact...');
      testContact = await Contact.create({
        userId: testUser.id,
        phone: '919999999999',
        name: 'Test Contact',
        status: 'active'
      });
      console.log(`✅ Created test contact: ID=${testContact.id}\n`);
    } else {
      console.log(`✅ Found contact: ID=${testContact.id}, Phone=${testContact.phone}\n`);
    }

    // 4. Try to save a test message
    console.log('4️⃣  Attempting to save test message to inboxmessages...');
    const testMessage = await InboxMessage.create({
      contactId: testContact.id,
      userId: testUser.id,
      direction: "outgoing",
      message: "Test Template: hello_world",
      type: "text",
      status: "sent",
      waMessageId: "test_wamid_123",
      timestamp: new Date()
    });
    console.log(`✅ Test message saved successfully! ID=${testMessage.id}\n`);

    // 5. Verify it was saved
    console.log('5️⃣  Verifying message was saved...');
    const savedMessage = await InboxMessage.findByPk(testMessage.id);
    if (savedMessage) {
      console.log('✅ Message found in database:');
      console.log('   ID:', savedMessage.id);
      console.log('   Contact ID:', savedMessage.contactId);
      console.log('   User ID:', savedMessage.userId);
      console.log('   Message:', savedMessage.message);
      console.log('   Status:', savedMessage.status);
      console.log('   Direction:', savedMessage.direction);
      console.log('\n✅ ALL TESTS PASSED! InboxMessage save is working correctly.\n');
    } else {
      console.error('❌ Message was not found after saving!');
      process.exit(1);
    }

    // 6. Clean up test message (optional)
    console.log('6️⃣  Cleaning up test message...');
    await testMessage.destroy();
    console.log('✅ Test message deleted\n');

    console.log('🎉 All tests completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ TEST FAILED!');
    console.error('Error Type:', error.name);
    console.error('Error Message:', error.message);
    console.error('Error Stack:', error.stack);
    
    if (error.message.includes("doesn't exist") || error.message.includes("Unknown table")) {
      console.error('\n⚠️  SOLUTION: The inboxmessages table doesn\'t exist.');
      console.error('   Run this SQL in your database:');
      console.error(`
CREATE TABLE IF NOT EXISTS \`inboxmessages\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`contactId\` INT NOT NULL,
  \`userId\` INT NOT NULL,
  \`direction\` ENUM('incoming', 'outgoing') NOT NULL,
  \`message\` TEXT NOT NULL,
  \`type\` ENUM('text', 'image', 'video', 'audio', 'document') DEFAULT 'text',
  \`status\` ENUM('sent', 'delivered', 'read', 'failed') DEFAULT 'sent',
  \`waMessageId\` VARCHAR(255) NULL,
  \`timestamp\` DATETIME DEFAULT CURRENT_TIMESTAMP,
  \`createdAt\` DATETIME NOT NULL,
  \`updatedAt\` DATETIME NOT NULL,
  PRIMARY KEY (\`id\`),
  INDEX \`contactId\` (\`contactId\`),
  INDEX \`userId\` (\`userId\`),
  CONSTRAINT \`inboxmessages_ibfk_1\` FOREIGN KEY (\`contactId\`) REFERENCES \`contacts\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`inboxmessages_ibfk_2\` FOREIGN KEY (\`userId\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    }

    if (error.name === 'SequelizeForeignKeyConstraintError') {
      console.error('\n⚠️  SOLUTION: Foreign key constraint failed.');
      console.error('   Make sure the Contact and User exist in the database.');
    }

    process.exit(1);
  }
}

// Run the test
testInboxSave();

