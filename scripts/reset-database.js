// Script to reset database tables
// Run: node scripts/reset-database.js
// WARNING: This will delete all data!

require('dotenv').config();
const { sequelize, User, Campaign, Contact, Template, Message } = require('../models');

async function resetDatabase() {
  try {
    console.log('🔄 Resetting database...');
    
    // Drop all tables
    await sequelize.drop({ cascade: true });
    console.log('✅ All tables dropped');
    
    // Recreate tables
    await sequelize.sync({ force: false });
    console.log('✅ All tables created');
    
    console.log('\n✅ Database reset complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error resetting database:', error.message);
    process.exit(1);
  }
}

resetDatabase();

