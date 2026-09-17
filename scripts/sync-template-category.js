// Script to sync Template table with updated category ENUM (including marketing)
// Run: node scripts/sync-template-category.js

require('dotenv').config();
const { Template } = require('../models');

async function syncTemplateCategory() {
  try {
    console.log('🔄 Syncing Template table with updated categories...');
    await Template.sync({ force: false, alter: true });
    console.log('✅ Template table synced successfully!');
    console.log('✅ Marketing category is now available in the database.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error syncing Template table:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

syncTemplateCategory();

