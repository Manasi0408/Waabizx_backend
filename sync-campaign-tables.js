require('dotenv').config({ path: './.env' });
const { Campaign, CampaignAudience } = require('./models');

async function syncTables() {
  try {
    console.log('🔄 Syncing Campaign table...');
    await Campaign.sync({ force: false, alter: true });
    console.log('✅ Campaign table synced with new columns.');
    
    console.log('🔄 Syncing CampaignAudience table...');
    await CampaignAudience.sync({ force: false, alter: true });
    console.log('✅ CampaignAudience table synced.');
    
    console.log('✅ All tables synced successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error syncing tables:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

syncTables();

