require('dotenv').config({ path: '../.env' });
const { Template, sequelize } = require('../models');

async function findRejectedTemplates(userId = null) {
  try {
    const where = {};
    if (userId) {
      where.userId = userId;
    }
    
    // Find templates with rejected status
    const rejectedTemplates = await Template.findAll({
      where: {
        ...where,
        status: 'rejected'
      },
      order: [['createdAt', 'DESC']]
    });

    console.log('\n📋 Rejected Templates:');
    console.log('='.repeat(80));
    
    if (rejectedTemplates.length === 0) {
      console.log('No rejected templates found.');
      return [];
    }

    rejectedTemplates.forEach((template, index) => {
      console.log(`\n${index + 1}. Template ID: ${template.id}`);
      console.log(`   Name: ${template.name}`);
      console.log(`   Category: ${template.category}`);
      console.log(`   Status: ${template.status}`);
      console.log(`   Created: ${template.createdAt}`);
      console.log(`   Content Preview: ${(template.content || '').substring(0, 100)}...`);
    });

    return rejectedTemplates;
  } catch (error) {
    console.error('❌ Error finding rejected templates:', error.message);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  const userId = process.argv[2] ? parseInt(process.argv[2]) : null;
  
  findRejectedTemplates(userId)
    .then(() => {
      console.log('\n✅ Done.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Error:', error);
      process.exit(1);
    });
}

module.exports = { findRejectedTemplates };

