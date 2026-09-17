/**
 * Backfill inboxmessages rows that only store "Template: {name}" without templateSnapshot.
 * Run: node scripts/backfill-inbox-template-snapshots.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Op } = require('sequelize');
const { InboxMessage, Template } = require('../models');
const { mergeTemplatePreviewWithCatalog, buildTemplateCatalogMap, isTemplateMarkerContent, finalizeTemplateSnapshotForInbox } = require('../utils/templatePreviewUtil');
const { resolveTemplateComponentsForSend } = require('../services/metaTemplateFetchService');
const { getTemplateComponents } = require('../utils/templateMessageComponents');
const Campaign = require('../models/Campaign');
const { extractTemplateNameFromBody } = require('../utils/inboxMessageApiUtil');

async function main() {
  const rows = await InboxMessage.findAll({
    where: { isTemplateSend: true },
    limit: 5000,
    order: [['id', 'ASC']],
  });

  let updated = 0;
  for (const row of rows) {
    const body = String(row.message || '').trim();
    const templateName = row.templateName || extractTemplateNameFromBody(body);
    if (!templateName) continue;

    const templateWhere = { name: templateName };
    if (row.projectId) templateWhere.projectId = row.projectId;

    const templateRecord = await Template.findOne({
      where: templateWhere,
      order: [['updatedAt', 'DESC']],
    });
    if (!templateRecord) continue;

    let components = getTemplateComponents(templateRecord);
    if (!components.length) {
      try {
        components = await resolveTemplateComponentsForSend(templateRecord, {
          userId: row.userId,
          projectId: row.projectId,
          templateName,
        });
      } catch (_) {}
    }
    const enrichedRecord = {
      ...(templateRecord.get ? templateRecord.get({ plain: true }) : templateRecord),
      components: components.length ? components : undefined,
      variables: {
        ...(templateRecord.variables && typeof templateRecord.variables === 'object'
          ? templateRecord.variables
          : {}),
        ...(components.length ? { components } : {}),
      },
    };

    let existing = null;
    if (row.templateSnapshot) {
      try {
        existing =
          typeof row.templateSnapshot === 'string'
            ? JSON.parse(row.templateSnapshot)
            : row.templateSnapshot;
      } catch {
        existing = null;
      }
    }

    const preview = mergeTemplatePreviewWithCatalog(
      existing,
      enrichedRecord,
      enrichedRecord.content || '',
      { templateName, body: isTemplateMarkerContent(body) ? null : body }
    );

    const campaignRow = await Campaign.findOne({
      where: { template_name: templateName, ...(row.projectId ? { projectId: row.projectId } : {}) },
      order: [['updatedAt', 'DESC']],
      attributes: ['header_media_url'],
    });
    const fakePayload = campaignRow?.header_media_url
      ? {
          template: {
            components: [
              {
                type: 'header',
                parameters: [{ type: 'image', image: { link: campaignRow.header_media_url } }],
              },
            ],
          },
        }
      : null;
    const finalized = finalizeTemplateSnapshotForInbox(
      preview,
      fakePayload,
      campaignRow?.header_media_url
    );
    if (!finalized?.body) continue;

    const needsUpdate =
      !existing ||
      !Array.isArray(existing.buttons) ||
      !existing.buttons.length ||
      !(existing.headerImageUrl || existing.header?.url) ||
      isTemplateMarkerContent(body);

    if (!needsUpdate && existing?.buttons?.length && (existing.headerImageUrl || existing.header?.url)) {
      continue;
    }

    await row.update({
      message: finalized.body,
      templateName,
      templateSnapshot: JSON.stringify(finalized),
      isTemplateSend: true,
      mediaUrl: finalized.headerImageUrl || finalized.header?.url || row.mediaUrl || null,
    });
    updated += 1;
  }

  console.log(`Backfill complete. Updated ${updated} of ${rows.length} candidate rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
