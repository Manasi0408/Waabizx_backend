/**
 * Script to create a test notification in the database
 * Usage: node backend/scripts/create-test-notification.js [userId] [title] [body] [type]
 * 
 * Example:
 * node backend/scripts/create-test-notification.js 1 "New Campaign" "Your campaign has been sent successfully" "campaign"
 */

require('dotenv').config();
const Notification = require('../models/notificationModel');

async function createTestNotification() {
  try {
    // Get arguments from command line
    const userId = parseInt(process.argv[2]) || 1;
    const title = process.argv[3] || `Test Notification ${new Date().toLocaleString()}`;
    const body = process.argv[4] || 'This is a test notification created from script';
    const type = process.argv[5] || 'message';

    console.log('📝 Creating test notification...');
    console.log(`   User ID: ${userId}`);
    console.log(`   Title: ${title}`);
    console.log(`   Body: ${body}`);
    console.log(`   Type: ${type}`);

    const notificationId = await Notification.create({
      userId,
      type,
      title,
      body
    });

    console.log(`\n✅ Notification created successfully!`);
    console.log(`   Notification ID: ${notificationId}`);
    console.log(`\n💡 To see this notification:`);
    console.log(`   1. Make sure you're logged in as user ID ${userId}`);
    console.log(`   2. Click the notification icon in the header`);
    console.log(`   3. The notification should appear at the top of the list\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating notification:', error);
    process.exit(1);
  }
}

createTestNotification();

