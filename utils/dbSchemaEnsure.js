const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

let carouselColumnEnsured = false;

async function resolveCampaignsTableName(queryInterface) {
  try {
    await queryInterface.describeTable('campaigns');
    return 'campaigns';
  } catch (_) {
    await queryInterface.describeTable('Campaigns');
    return 'Campaigns';
  }
}

/** MySQL ENUM is case-insensitive — COMPLETED and completed count as duplicates. */
async function ensureCampaignStatusEnumValid() {
  const tableName = await resolveCampaignsTableName(sequelize.getQueryInterface());
  await sequelize.query(
    `UPDATE \`${tableName}\` SET status = 'COMPLETED' WHERE LOWER(status) = 'completed' AND status <> 'COMPLETED'`
  );
  await sequelize.query(
    `UPDATE \`${tableName}\` SET status = 'PAUSED' WHERE LOWER(status) = 'paused' AND status <> 'PAUSED'`
  );
  await sequelize.query(`
    ALTER TABLE \`${tableName}\`
    MODIFY COLUMN status ENUM(
      'draft','PENDING','PROCESSING','COMPLETED','PAUSED','scheduled','active'
    ) NOT NULL DEFAULT 'draft'
  `);
}

/** Adds campaigns.carousel_card_media_urls when missing (MySQL JSON). Safe to call repeatedly. */
async function ensureCampaignCarouselMediaColumn() {
  if (carouselColumnEnsured) return true;
  try {
    await ensureCampaignStatusEnumValid();
  } catch (enumErr) {
    console.warn('ensureCampaignStatusEnumValid:', enumErr?.message || enumErr);
  }
  const queryInterface = sequelize.getQueryInterface();
  const tableName = await resolveCampaignsTableName(queryInterface);
  const table = await queryInterface.describeTable(tableName);
  const colNames = Object.keys(table || {}).map((c) => c.toLowerCase());
  if (!colNames.includes('carousel_card_media_urls')) {
    await queryInterface.addColumn(tableName, 'carousel_card_media_urls', {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    });
    console.log(`✅ ${tableName}.carousel_card_media_urls column added.`);
  }
  carouselColumnEnsured = true;
  return true;
}

function isMissingCarouselColumnError(err) {
  const msg = String(err?.message || err?.parent?.message || '').toLowerCase();
  return msg.includes('carousel_card_media_urls') && msg.includes('unknown column');
}

const Campaign = require('../models/Campaign');
const { stashCarouselUrlsInVariableMapping } = require('./templateMessageComponents');

async function createCampaignWithCarouselSupport(payload) {
  if (payload?.carousel_card_media_urls) {
    try {
      await ensureCampaignCarouselMediaColumn();
    } catch (ensureErr) {
      console.warn('ensureCampaignCarouselMediaColumn:', ensureErr?.message || ensureErr);
    }
  }
  try {
    return await Campaign.create(payload);
  } catch (err) {
    if (!isMissingCarouselColumnError(err)) throw err;
    await ensureCampaignCarouselMediaColumn();
    try {
      return await Campaign.create(payload);
    } catch (retryErr) {
      if (!isMissingCarouselColumnError(retryErr)) throw retryErr;
      const carouselUrls = payload.carousel_card_media_urls;
      const { carousel_card_media_urls: _drop, variable_mapping, ...rest } = payload;
      return await Campaign.create({
        ...rest,
        variable_mapping: stashCarouselUrlsInVariableMapping(variable_mapping, carouselUrls),
      });
    }
  }
}

module.exports = {
  ensureCampaignCarouselMediaColumn,
  isMissingCarouselColumnError,
  createCampaignWithCarouselSupport,
};
