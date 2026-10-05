require('dotenv').config();
const sequelize = require('../config/database');

(async () => {
  try {
    const [rows] = await sequelize.query(
      "SHOW COLUMNS FROM campaigns LIKE 'carousel_card_media_urls'"
    );
    if (!rows.length) {
      await sequelize.query(
        'ALTER TABLE campaigns ADD COLUMN carousel_card_media_urls JSON NULL'
      );
      console.log('Added campaigns.carousel_card_media_urls');
    } else {
      console.log('campaigns.carousel_card_media_urls already exists');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
})();
