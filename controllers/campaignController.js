const axios = require('axios');
const { Campaign, CampaignAudience, Contact, InboxMessage, Template } = require('../models');
const { Op } = require('sequelize');
const { requireProjectId } = require('../utils/projectScope');
const { enforcePlanLimit } = require('../services/planLimitService');
const { upsertConversationWithQuota } = require('../services/conversationBillingService');
const {
  requireWccForOutgoing,
} = require('../services/wccMetaChargeService');
const socketService = require('../services/socketService');
const {
  resolveWhatsAppSendCredentialCandidates,
  postWhatsAppTemplateMessage,
  formatMetaApiErrorMessage,
  getMetaTokenFromEnv,
} = require('../utils/metaWhatsAppCredentials');

function getMetaErrorCode(err) {
  const fromBody =
    err?.response?.data?.error?.code ??
    err?.response?.data?.code ??
    null;
  if (fromBody != null) return fromBody;
  const matched = /\(#(\d+)\)/.exec(String(err?.message || ''));
  return matched ? Number(matched[1]) : null;
}

async function buildCampaignTemplatePayload({
  sendSpec,
  metaComponents,
  campaign,
  campaignHeaderMediaUrl,
  headerMediaId,
  audienceMember,
  normalizedTemplateName,
  effectiveTemplateLanguage,
  normalizedPhoneNumber,
  includeButtons = true,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: normalizedPhoneNumber,
    type: 'template',
    template: {
      name: normalizedTemplateName,
      language: { code: effectiveTemplateLanguage },
    },
  };

  if (!sendSpec?.needsHeaderMedia || campaignHeaderMediaUrl) {
    const components = buildWhatsAppTemplateComponents({
      sendSpec,
      headerMediaUrl: toPublicMediaUrl(campaign.header_media_url) || campaignHeaderMediaUrl,
      headerMediaId,
      audienceMember,
    });
    let merged = components;
    if (includeButtons) {
      const buttonComponents = extractDynamicUrlButtonComponents(metaComponents, audienceMember);
      if (buttonComponents.length) {
        merged = [...(components || []), ...buttonComponents];
      }
    }
    if (merged?.length) {
      payload.template.components = merged;
    }
  }

  return payload;
}

function normalizeCampaignAudiencePhone(phone) {
  return (
    normalizeWhatsAppRecipient(phone) ||
    String(phone || '')
      .trim()
      .replace(/\D/g, '')
  );
}

function accountWideContactWhere(userId, projectId, extra = {}) {
  const pid = Number(projectId);
  const scoped =
    Number.isInteger(pid) && pid > 0
      ? { [Op.or]: [{ projectId: pid }, { projectId: null }] }
      : {};
  return { userId, ...extra, ...scoped };
}

async function postTemplateWithMarketingFallback(waCandidates, payload, sendOptions) {
  try {
    return await postWhatsAppTemplateMessage(waCandidates, payload, sendOptions);
  } catch (err) {
    const current = sendOptions?.isMarketing === true;
    try {
      return await postWhatsAppTemplateMessage(waCandidates, payload, {
        ...sendOptions,
        isMarketing: !current,
      });
    } catch (flipErr) {
      throw flipErr || err;
    }
  }
}

async function sendCampaignTemplateWithRetries({
  waCandidates,
  sendSpec,
  metaComponents,
  campaign,
  campaignHeaderMediaUrl,
  cachedHeaderMediaId = null,
  cachedHeaderMediaPhoneId = null,
  audienceMember,
  normalizedTemplateName,
  effectiveTemplateLanguage,
  normalizedPhoneNumber,
  userId,
  projectId,
  templateBillingCategory,
}) {
  const primaryCreds = waCandidates.find((c) => c?.phoneNumberId && c?.accessToken);
  const headerMediaSource = campaign.header_media_url || campaignHeaderMediaUrl;
  const isMarketing = templateBillingCategory === 'marketing';
  const sendOptions = { userId, projectId, isMarketing };
  const needsHeaderMedia = Boolean(sendSpec?.needsHeaderMedia && headerMediaSource);

  const attempts = [];
  if (needsHeaderMedia && primaryCreds) {
    attempts.push({ label: 'media_id_with_buttons', freshMediaId: true, includeButtons: true });
    attempts.push({ label: 'media_id_no_buttons', freshMediaId: true, includeButtons: false });
    if (cachedHeaderMediaId) {
      attempts.push({
        label: 'cached_media_id_with_buttons',
        headerMediaId: cachedHeaderMediaId,
        includeButtons: true,
      });
      attempts.push({
        label: 'cached_media_id_no_buttons',
        headerMediaId: cachedHeaderMediaId,
        includeButtons: false,
      });
    }
    if (campaignHeaderMediaUrl) {
      attempts.push({ label: 'public_link_with_buttons', useLink: true, includeButtons: true });
      attempts.push({ label: 'public_link_no_buttons', useLink: true, includeButtons: false });
    }
  } else {
    attempts.push({ label: 'components_with_buttons', freshMediaId: false, includeButtons: true });
    attempts.push({ label: 'components_no_buttons', freshMediaId: false, includeButtons: false });
    if (!sendSpec?.needsHeaderMedia) {
      attempts.push({ label: 'bare_template', bare: true });
    }
  }

  let preferredHeaderPhoneId = cachedHeaderMediaPhoneId || null;

  let lastError = null;
  for (const attempt of attempts) {
    try {
      if (attempt.bare) {
        const barePayload = {
          messaging_product: 'whatsapp',
          to: normalizedPhoneNumber,
          type: 'template',
          template: {
            name: normalizedTemplateName,
            language: { code: effectiveTemplateLanguage },
          },
        };
        return await postTemplateWithMarketingFallback(waCandidates, barePayload, {
          ...sendOptions,
          preferredPhoneNumberId: preferredHeaderPhoneId || sendOptions.preferredPhoneNumberId,
        });
      }

      let headerMediaId = attempt.headerMediaId || null;
      if (attempt.freshMediaId && needsHeaderMedia) {
        const uploaded = await resolveHeaderMediaIdForSend(
          waCandidates,
          headerMediaSource,
          sendSpec.headerFormat,
          { preferredPhoneNumberId: preferredHeaderPhoneId }
        );
        if (!uploaded?.mediaId) continue;
        headerMediaId = uploaded.mediaId;
        preferredHeaderPhoneId = uploaded.phoneNumberId || preferredHeaderPhoneId;
      }

      if (attempt.useLink && needsHeaderMedia) {
        if (!campaignHeaderMediaUrl) continue;
        headerMediaId = null;
      } else if (needsHeaderMedia && !headerMediaId) {
        continue;
      }

      const templatePayload = await buildCampaignTemplatePayload({
        sendSpec,
        metaComponents,
        campaign,
        campaignHeaderMediaUrl,
        headerMediaId,
        audienceMember,
        normalizedTemplateName,
        effectiveTemplateLanguage,
        normalizedPhoneNumber,
        includeButtons: attempt.includeButtons,
      });

      return await postTemplateWithMarketingFallback(waCandidates, templatePayload, {
        ...sendOptions,
        preferredPhoneNumberId: preferredHeaderPhoneId || sendOptions.preferredPhoneNumberId,
      });
    } catch (err) {
      lastError = err;
      // Try remaining payload shapes (bare template, link header, cached media, etc.)
    }
  }

  if (needsHeaderMedia) {
    throw (
      lastError ||
      new Error(
        'Could not send template with header media. Upload a JPEG/PNG image (under 5MB) from Media Library and retry.'
      )
    );
  }
  throw lastError || new Error('WhatsApp template send failed');
}
const { seedFlowSessionForCampaignTemplate } = require('../services/flowWhatsAppService');
const tagService = require('../services/tagService');
const {
  parseTemplateSendSpec,
  buildWhatsAppTemplateComponents,
  toPublicMediaUrl,
  toPermanentUploadPath,
  getTemplateComponents,
  extractButtonsFromComponents,
  applyCampaignHeaderHint,
  buildBodyParamsFromAudience,
  extractDynamicUrlButtonComponents,
} = require('../utils/templateMessageComponents');
const { buildClientTemplatePreview, enrichTemplateRecordWithComponents, finalizeTemplateSnapshotForInbox } = require('../utils/templatePreviewUtil');
const { resolveHeaderMediaIdForSend } = require('../services/templateHeaderSendService');
const {
  loadTemplateRecordForCampaign,
  resolveTemplateComponentsForSend,
  fetchMetaTemplateByName,
} = require('../services/metaTemplateFetchService');
const {
  resolveTemplateBillingCategory,
  getMessageRateForBillingCategory,
  getBillingCategoryLabel,
  calculateCampaignTotalCreditUsageRupees,
  calculateCampaignTotalCreditUsageForPhones,
} = require('../utils/messageCategoryPricing');
const {
  normalizeWhatsAppRecipient,
  phoneVariantsForLookup,
} = require('../utils/phoneNormalize');
const Project = require('../models/Project');
const {
  calculateCampaignCost,
  calculateCampaignCostByPhones,
  getCampaignContacts,
} = require('../services/campaignCostService');
const { getWalletCurrencyForOwner } = require('../services/wccCountryPricingService');
const { calculateCampaignPricingSummary } = require('../services/campaignPricingService');

async function findOrCreateCampaignContact({ userId, projectId, phone }) {
  const variants = phoneVariantsForLookup(phone);
  const normalizedPhone = normalizeCampaignAudiencePhone(phone);

  let contact = await Contact.findOne({
    where: {
      userId,
      phone: { [Op.in]: variants.length ? variants : [normalizedPhone] },
      projectId,
    },
  });

  if (!contact) {
    contact = await Contact.findOne({
      where: {
        userId,
        phone: { [Op.in]: variants.length ? variants : [normalizedPhone] },
        projectId: null,
      },
    });
  }

  if (!contact) {
    contact = await Contact.findOne({
      where: {
        userId,
        phone: { [Op.in]: variants.length ? variants : [normalizedPhone] },
      },
      order: [['updatedAt', 'DESC']],
    });
  }

  if (contact) return contact;

  try {
    return await Contact.create({
      userId,
      projectId: null,
      phone: normalizedPhone,
      name: normalizedPhone,
      status: 'active',
      whatsappOptInAt: new Date(),
      email: null,
      customFields: {},
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      contact = await Contact.findOne({
        where: {
          userId,
          phone: { [Op.in]: variants.length ? variants : [normalizedPhone] },
        },
        order: [['updatedAt', 'DESC']],
      });
      if (contact) return contact;
    }
    throw err;
  }
}

// Store active campaign processors
const activeProcessors = new Map();

function stopCampaignProcessor(campaignId) {
  const handle = activeProcessors.get(campaignId);
  if (!handle) return;
  if (typeof handle === 'number') {
    clearInterval(handle);
  } else if (handle && typeof handle === 'object') {
    handle.stop = true;
  }
  activeProcessors.delete(campaignId);
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  if (!list.length) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (index < list.length) {
      const current = list[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function calculateCampaignAudienceStats(campaignId) {
  const [total, sent, delivered, read, failed] = await Promise.all([
    CampaignAudience.count({ where: { campaignId } }),
    CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['sent', 'delivered', 'read'] } } }),
    CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['delivered', 'read'] } } }),
    CampaignAudience.count({ where: { campaignId, status: 'read' } }),
    CampaignAudience.count({ where: { campaignId, status: 'failed' } })
  ]);

  return { total, sent, delivered, read, failed };
}

const REPLY_ELIGIBLE_AUDIENCE_STATUS = { status: { [Op.in]: ['sent', 'delivered', 'read'] } };
const VALID_REPLY_HOUR_WINDOWS = [1, 3, 24];

function resolveContactIdForPhone(phone, variantToContactId) {
  for (const variant of phoneVariantsForLookup(phone)) {
    if (variantToContactId.has(variant)) {
      return variantToContactId.get(variant);
    }
  }
  const normalized = normalizeCampaignAudiencePhone(phone);
  return variantToContactId.get(normalized) || null;
}

async function loadCampaignReplyContext(campaignId, userId, projectId) {
  const audienceRows = await CampaignAudience.findAll({
    where: { campaignId, ...REPLY_ELIGIBLE_AUDIENCE_STATUS },
    order: [['id', 'ASC']],
    attributes: [
      'id',
      'phone',
      'var1',
      'var2',
      'var3',
      'var4',
      'var5',
      'sentAt',
      'readAt',
      'deliveredAt',
      'createdAt',
    ],
  });

  if (!audienceRows.length) {
    return { audienceRows: [], contactById: new Map(), messagesByContact: new Map() };
  }

  const allVariants = new Set();
  for (const row of audienceRows) {
    phoneVariantsForLookup(row.phone).forEach((variant) => allVariants.add(variant));
    const normalized = normalizeCampaignAudiencePhone(row.phone);
    if (normalized) allVariants.add(normalized);
  }

  const contacts = allVariants.size
    ? await Contact.findAll({
        where: {
          userId,
          phone: { [Op.in]: [...allVariants] },
          [Op.or]: [{ projectId }, { projectId: null }],
        },
        attributes: ['id', 'phone', 'name'],
      })
    : [];

  const variantToContactId = new Map();
  const contactById = new Map();
  for (const contact of contacts) {
    contactById.set(contact.id, contact);
    phoneVariantsForLookup(contact.phone).forEach((variant) => {
      if (!variantToContactId.has(variant)) variantToContactId.set(variant, contact.id);
    });
    const normalized = normalizeCampaignAudiencePhone(contact.phone);
    if (normalized && !variantToContactId.has(normalized)) {
      variantToContactId.set(normalized, contact.id);
    }
  }

  const contactIds = [...new Set(variantToContactId.values())];
  const incomingMessages = contactIds.length
    ? await InboxMessage.findAll({
        where: {
          contactId: { [Op.in]: contactIds },
          direction: 'incoming',
          userId,
          [Op.or]: [{ projectId }, { projectId: null }],
        },
        order: [['timestamp', 'ASC']],
        attributes: ['contactId', 'timestamp'],
      })
    : [];

  const messagesByContact = new Map();
  for (const message of incomingMessages) {
    if (!messagesByContact.has(message.contactId)) {
      messagesByContact.set(message.contactId, []);
    }
    messagesByContact.get(message.contactId).push(message);
  }

  return { audienceRows, contactById, messagesByContact, variantToContactId };
}

function findFirstReplyForAudienceRow(row, { variantToContactId, messagesByContact, hours = null }) {
  const contactId = resolveContactIdForPhone(row.phone, variantToContactId);
  if (!contactId) return null;

  const anchor = row.sentAt || row.deliveredAt || row.readAt || row.createdAt;
  if (!anchor) return null;

  const anchorTime = new Date(anchor).getTime();
  const windowEnd = hours != null ? anchorTime + Number(hours) * 3600000 : null;
  const messages = messagesByContact.get(contactId) || [];

  for (const message of messages) {
    const replyTime = new Date(message.timestamp).getTime();
    if (replyTime < anchorTime) continue;
    if (windowEnd != null && replyTime > windowEnd) continue;
    return message.timestamp;
  }

  return null;
}

async function buildCampaignReplyAudience({ campaignId, userId, projectId, hours = null }) {
  const { audienceRows, contactById, messagesByContact, variantToContactId } =
    await loadCampaignReplyContext(campaignId, userId, projectId);

  const results = [];
  for (const row of audienceRows) {
    const repliedAt = findFirstReplyForAudienceRow(row, {
      variantToContactId,
      messagesByContact,
      hours,
    });
    if (!repliedAt) continue;

    const contactId = resolveContactIdForPhone(row.phone, variantToContactId);
    const contact = contactId ? contactById.get(contactId) : null;
    const name =
      (contact?.name && String(contact.name).trim()) ||
      (row.var1 && String(row.var1).trim()) ||
      row.phone;

    results.push({
      phone: row.phone,
      name,
      readAt: row.readAt || null,
      repliedAt,
      var1: row.var1 || null,
      var2: row.var2 || null,
      var3: row.var3 || null,
      var4: row.var4 || null,
      var5: row.var5 || null,
    });
  }

  return results;
}

async function calculateCampaignReplyCount(campaignId, userId, projectId) {
  const audience = await buildCampaignReplyAudience({
    campaignId,
    userId,
    projectId,
    hours: null,
  });
  return audience.length;
}

function parseTemplateVariablesField(variables) {
  if (!variables) return {};
  if (typeof variables === 'string') {
    try {
      const parsed = JSON.parse(variables);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  if (typeof variables === 'object' && !Array.isArray(variables)) return variables;
  return {};
}

async function resolveCampaignTemplateBillingCategory(campaign, userId, projectId) {
  const templateName = String(campaign?.template_name || '').trim();
  if (!templateName) return 'marketing';

  const template = await loadTemplateRecordForCampaign({ userId, projectId, templateName });
  if (template) {
    const vars = parseTemplateVariablesField(template.variables);
    return resolveTemplateBillingCategory({
      category: template.category,
      metaCategory: vars.metaCategory,
      variables: vars,
    });
  }

  try {
    const metaTpl = await fetchMetaTemplateByName(templateName, userId, projectId);
    if (metaTpl?.category) {
      return resolveTemplateBillingCategory({ metaCategory: metaTpl.category });
    }
  } catch (_) {
    /* optional Meta lookup */
  }

  return 'marketing';
}

// Map contact field to value (name, phone, or customFields[key])
function getContactVarValue(contact, key) {
  if (!key) return '';
  const k = String(key).toLowerCase();
  if (k === 'name') return contact.name || '';
  if (k === 'phone') return contact.phone || '';
  const custom = contact.customFields || {};
  return custom[key] != null ? String(custom[key]) : (contact[key] != null ? String(contact[key]) : '');
}

// Build var1..var5 from contact using variable_mapping { "1": "name", "2": "order_id" }
function buildAudienceVars(contact, variable_mapping) {
  const vars = { var1: null, var2: null, var3: null, var4: null, var5: null };
  if (!variable_mapping || typeof variable_mapping !== 'object') return vars;
  ['1', '2', '3', '4', '5'].forEach((num, i) => {
    const field = variable_mapping[num] || variable_mapping[i + 1];
    if (field) vars[`var${i + 1}`] = getContactVarValue(contact, field);
  });
  return vars;
}

function normalizeContactIdsFromPayload(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item == null) return null;
        if (typeof item === 'object') return parseInt(item.id, 10);
        return parseInt(item, 10);
      })
      .filter((id) => Number.isInteger(id) && id > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((id) => Number.isInteger(id) && id > 0);
  }
  return [];
}

function normalizeAudienceFromPayload(audiencePayload) {
  if (!Array.isArray(audiencePayload)) return [];
  return audiencePayload
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const phone = normalizeCampaignAudiencePhone(item.trim());
        if (!phone || phone.length < 10) return null;
        return { phone, var1: null, var2: null, var3: null, var4: null, var5: null };
      }
      if (typeof item === 'number') {
        return null;
      }
      const phone = normalizeCampaignAudiencePhone(
        String(item.phone || item.msisdn || item.to || '').trim()
      );
      if (!phone || phone.length < 10) return null;
      return {
        phone,
        var1: item.var1 || null,
        var2: item.var2 || null,
        var3: item.var3 || null,
        var4: item.var4 || null,
        var5: item.var5 || null
      };
    })
    .filter(Boolean);
}

// Create Campaign (draft or with audience)
exports.createCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { name, template_name, template_language = "en_US", schedule_time, audience, variable_mapping, contactIds, tags, header_media_url } = req.body;
    const tagIds = tags || req.body.tagIds;

    if (!name || !template_name) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, template_name'
      });
    }

    const loadedTemplate = await loadTemplateRecordForCampaign({
      userId,
      projectId,
      templateName: template_name,
    });
    const metaComponents = loadedTemplate
      ? await resolveTemplateComponentsForSend(loadedTemplate, {
          userId,
          projectId,
          templateName: template_name,
        })
      : [];
    const metaTpl = await fetchMetaTemplateByName(template_name, userId, projectId);
    const componentsForSpec =
      metaComponents.length > 0
        ? metaComponents
        : Array.isArray(metaTpl?.components)
          ? metaTpl.components
          : [];
    const sendSpec = parseTemplateSendSpec(
      componentsForSpec,
      loadedTemplate?.content || metaTpl?.components?.find((c) => String(c.type || '').toUpperCase() === 'BODY')?.text || '',
      {
        templateType:
          loadedTemplate?.variables &&
          typeof loadedTemplate.variables === 'object' &&
          !Array.isArray(loadedTemplate.variables)
            ? loadedTemplate.variables.templateType
            : null,
      }
    );
    const finalLanguage =
      template_language ||
      metaTpl?.language ||
      (loadedTemplate?.variables &&
      typeof loadedTemplate.variables === 'object' &&
      !Array.isArray(loadedTemplate.variables) &&
      loadedTemplate.variables.language
        ? String(loadedTemplate.variables.language)
        : null) ||
      'en_US';

    const storedHeaderMediaUrl =
      toPermanentUploadPath(header_media_url) ||
      (/^https?:\/\//i.test(String(header_media_url || '').trim())
        ? String(header_media_url).trim()
        : null);

    if (sendSpec.needsHeaderMedia && !toPublicMediaUrl(storedHeaderMediaUrl)) {
      return res.status(400).json({
        success: false,
        message:
          'This template requires header media (image, video, or document). Upload media or provide a public HTTPS URL before sending.',
      });
    }

    const limitCheck = await enforcePlanLimit(req, res, 'campaigns');
    if (limitCheck && !limitCheck.allowed) return;

    // Draft: no audience yet. Or with contactIds + variable_mapping. Or legacy: audience array.
    let status = 'draft';
    let total = 0;

    if (contactIds && Array.isArray(contactIds) && contactIds.length > 0 && variable_mapping) {
      status = 'PENDING';
      const contacts = await Contact.findAll({
        where: accountWideContactWhere(userId, projectId, { id: contactIds }),
        attributes: ['id', 'phone', 'name', 'customFields']
      });
      total = contacts.length;
    } else if (Array.isArray(tagIds) && tagIds.length > 0 && variable_mapping) {
      status = 'PENDING';
      const contacts = await tagService.getContactsByTagIds({ projectId, userId, tagIds });
      total = contacts.length;
    } else if (audience && Array.isArray(audience) && audience.length > 0) {
      status = 'PENDING';
      total = audience.length;
    } else if (status === 'draft' && String(req.body.status || '').toUpperCase() === 'PENDING') {
      // PENDING without audience: add contacts via POST .../contacts before start (testing / staged setup)
      status = 'PENDING';
    }

    const campaign = await Campaign.create({
      userId,
      projectId,
      name,
      template_name,
      template_language: finalLanguage,
      variable_mapping: variable_mapping || null,
      header_media_url: storedHeaderMediaUrl,
      template_header_format: sendSpec.headerFormat || null,
      schedule_time: schedule_time ? new Date(schedule_time) : null,
      status,
      total,
      totalRecipients: total
    });

    if (contactIds && Array.isArray(contactIds) && contactIds.length > 0 && variable_mapping) {
      const contacts = await Contact.findAll({
        where: accountWideContactWhere(userId, projectId, { id: contactIds }),
        attributes: ['id', 'phone', 'name', 'customFields']
      });
      const audienceRecords = contacts.map(c => {
        const v = buildAudienceVars(c, variable_mapping);
        return {
          campaignId: campaign.id,
          phone: normalizeCampaignAudiencePhone(c.phone),
          var1: v.var1, var2: v.var2, var3: v.var3, var4: v.var4, var5: v.var5,
          status: 'pending'
        };
      });
      await CampaignAudience.bulkCreate(audienceRecords);
    } else if (Array.isArray(tagIds) && tagIds.length > 0 && variable_mapping) {
      const contacts = await tagService.getContactsByTagIds({ projectId, userId, tagIds });
      const audienceRecords = contacts.map(c => {
        const v = buildAudienceVars(c, variable_mapping);
        return {
          campaignId: campaign.id,
          phone: normalizeCampaignAudiencePhone(c.phone),
          var1: v.var1, var2: v.var2, var3: v.var3, var4: v.var4, var5: v.var5,
          status: 'pending'
        };
      });
      await CampaignAudience.bulkCreate(audienceRecords);
    } else if (audience && Array.isArray(audience) && audience.length > 0) {
      const normalizedAudience = normalizeAudienceFromPayload(audience);
      const audienceRecords = normalizedAudience.map((aud) => ({
        campaignId: campaign.id,
        phone: aud.phone,
        var1: aud.var1 || null,
        var2: aud.var2 || null,
        var3: aud.var3 || null,
        var4: aud.var4 || null,
        var5: aud.var5 || null,
        status: 'pending'
      }));
      await CampaignAudience.bulkCreate(audienceRecords);
    }

    res.status(201).json({
      success: true,
      campaignId: campaign.id,
      status: campaign.status,
      total
    });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Add contacts to campaign (map template variables from contact fields)
exports.addContactsToCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;
    const { contactIds, tags, variable_mapping } = req.body;
    const tagIds = tags || req.body.tagIds;

    if (!variable_mapping || typeof variable_mapping !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'variable_mapping is required (e.g. { "1": "name", "2": "order_id" })'
      });
    }

    const hasContactIds = Array.isArray(contactIds) && contactIds.length > 0;
    const hasTags = Array.isArray(tagIds) && tagIds.length > 0;
    if (!hasContactIds && !hasTags) {
      return res.status(400).json({
        success: false,
        message: 'Provide contactIds (array) or tags (array of tag ids)'
      });
    }

    const campaign = await Campaign.findOne({
      where: { id: campaignId, userId, projectId }
    });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    if (campaign.status !== 'draft' && campaign.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Can only add contacts to draft or pending campaigns'
      });
    }

    await campaign.update({ variable_mapping });

    let contacts = [];
    if (hasTags) {
      contacts = await tagService.getContactsByTagIds({ projectId, userId, tagIds });
    } else {
      contacts = await Contact.findAll({
        where: accountWideContactWhere(userId, projectId, { id: contactIds }),
        attributes: ['id', 'phone', 'name', 'customFields']
      });
    }

    const existingPhones = new Set(
      (await CampaignAudience.findAll({ where: { campaignId }, attributes: ['phone'] })).map(a => a.phone)
    );
    const toAdd = contacts.filter(c => !existingPhones.has(c.phone));
    const audienceRecords = toAdd.map(c => {
      const v = buildAudienceVars(c, variable_mapping);
      return {
        campaignId,
        phone: c.phone,
        var1: v.var1, var2: v.var2, var3: v.var3, var4: v.var4, var5: v.var5,
        status: 'pending'
      };
    });
    if (audienceRecords.length > 0) {
      await CampaignAudience.bulkCreate(audienceRecords);
    }

    const total = await CampaignAudience.count({ where: { campaignId } });
    await campaign.update({ total, totalRecipients: total, status: 'PENDING' });

    res.json({
      success: true,
      message: `Added ${audienceRecords.length} contacts to campaign`,
      added: audienceRecords.length,
      total
    });
  } catch (error) {
    console.error('Error adding contacts to campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Get Campaign List
exports.getCampaigns = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { status, type, page = 1, limit = 10 } = req.query;

    const where = { userId, projectId };
    if (status) where.status = status;
    if (type) where.type = type;

    const parsedLimit = Math.max(1, parseInt(limit, 10) || 10);
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (parsedPage - 1) * parsedLimit;

    const { count, rows: campaigns } = await Campaign.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: parsedLimit,
      offset,
      attributes: ['id', 'name', 'description', 'type', 'template_name', 'template_language', 'variable_mapping', 'status', 'total', 'sent', 'delivered', 'read', 'failed', 'createdAt', 'updatedAt']
    });

    // Calculate dynamic stats from CampaignAudience for each campaign
    const campaignsWithStats = await Promise.all(
      campaigns.map(async (campaign) => {
        try {
          const stat = await calculateCampaignAudienceStats(campaign.id);
          
          // Use dynamic stats if available, otherwise fallback to campaign table values
          const campaignData = campaign.toJSON();
          campaignData.sent = stat ? parseInt(stat.sent, 10) || 0 : (campaign.sent || 0);
          campaignData.delivered = stat ? parseInt(stat.delivered, 10) || 0 : (campaign.delivered || 0);
          campaignData.read = stat ? parseInt(stat.read, 10) || 0 : (campaign.read || 0);
          campaignData.failed = stat ? parseInt(stat.failed, 10) || 0 : (campaign.failed || 0);
          campaignData.total = stat ? parseInt(stat.total, 10) || 0 : (campaign.total || 0);
          try {
            campaignData.replied = await calculateCampaignReplyCount(campaign.id, userId, projectId);
          } catch (replyErr) {
            console.error(`Error calculating reply count for campaign ${campaign.id}:`, replyErr);
            campaignData.replied = 0;
          }

          return campaignData;
        } catch (statError) {
          console.error(`Error calculating stats for campaign ${campaign.id}:`, statError);
          // Return campaign with existing values if stat calculation fails
          return campaign.toJSON();
        }
      })
    );

    res.json({
      success: true,
      campaigns: campaignsWithStats,
      pagination: {
        total: count,
        page: parsedPage,
        pages: Math.ceil(count / parsedLimit),
        limit: parsedLimit
      }
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Get Single Campaign + Stats
exports.getCampaignById = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const campaign = await Campaign.findOne({
      where: {
        id: campaignId,
        userId,
        projectId
      }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Calculate dynamic stats from CampaignAudience table
    let stats = {
      total: campaign.total || 0,
      sent: campaign.sent || 0,
      delivered: campaign.delivered || 0,
      read: campaign.read || 0,
      failed: campaign.failed || 0
    };

    try {
      const stat = await calculateCampaignAudienceStats(campaignId);
      stats = {
        total: parseInt(stat.total, 10) || 0,
        sent: parseInt(stat.sent, 10) || 0,
        delivered: parseInt(stat.delivered, 10) || 0,
        read: parseInt(stat.read, 10) || 0,
        failed: parseInt(stat.failed, 10) || 0
      };
    } catch (statError) {
      console.error(`Error calculating stats for campaign ${campaignId}:`, statError);
      // Use campaign table values as fallback
    }

    let replied = 0;
    try {
      replied = await calculateCampaignReplyCount(campaignId, userId, projectId);
    } catch (replyErr) {
      console.error(`Error calculating reply count for campaign ${campaignId}:`, replyErr);
    }

    const audience =
      parseInt(campaign.totalRecipients, 10) ||
      parseInt(stats.total, 10) ||
      (await CampaignAudience.count({ where: { campaignId } }));

    const billingCategory = await resolveCampaignTemplateBillingCategory(campaign, userId, projectId);
    const ratePerMessage = getMessageRateForBillingCategory(billingCategory);
    let totalCreditUsage = calculateCampaignTotalCreditUsageRupees(stats.sent, billingCategory);
    try {
      const sentAudience = await CampaignAudience.findAll({
        where: {
          campaignId,
          status: { [Op.in]: ['sent', 'delivered', 'read'] },
        },
        attributes: ['phone'],
      });
      const phones = sentAudience.map((row) => row.phone).filter(Boolean);
      if (phones.length) {
        totalCreditUsage = await calculateCampaignTotalCreditUsageForPhones(
          phones,
          billingCategory,
          userId
        );
      }
    } catch (estimateErr) {
      console.warn('[WCC] Country-aware campaign estimate fallback:', estimateErr?.message || estimateErr);
    }

    res.json({
      success: true,
      id: campaign.id,
      name: campaign.name,
      template_name: campaign.template_name,
      template_language: campaign.template_language,
      template_billing_category: billingCategory,
      template_category_label: getBillingCategoryLabel(billingCategory),
      rate_per_message: ratePerMessage,
      variable_mapping: campaign.variable_mapping,
      status: campaign.status,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      audience,
      totalCreditUsage,
      replied,
      stats: {
        ...stats,
        replied,
      },
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Start Campaign Manually
exports.startCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const campaign = await Campaign.findOne({
      where: {
        id: campaignId,
        userId,
        projectId
      }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    if (campaign.status === 'PROCESSING') {
      return res.status(400).json({
        success: false,
        message: 'Campaign is already processing'
      });
    }

    if (campaign.status === 'COMPLETED') {
      return res.status(400).json({
        success: false,
        message: 'Campaign is already completed'
      });
    }

    const normalizeMetaTemplateName = (name) => {
      // Meta template names must be lowercase, numbers and underscores only (no spaces)
      if (!name) return '';
      return String(name)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    };

    // Preflight: verify template exists & is approved in Meta (most common failure)
    try {
      const WABA_ID = process.env.WABA_ID;
      const TOKEN = getMetaTokenFromEnv();
      const normalizedTemplateName = normalizeMetaTemplateName(campaign.template_name);
      if (WABA_ID && TOKEN && normalizedTemplateName) {
        const url = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`;
        const resp = await axios.get(url, {
          params: { name: normalizedTemplateName, limit: 50 },
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const templates = resp.data?.data || [];
        const lang = String(campaign.template_language || 'en_US');
        const match = templates.find(t => String(t?.name) === String(normalizedTemplateName) && String(t?.language) === lang);
        if (!match) {
          return res.status(400).json({
            success: false,
            message: `Meta template not found for name="${campaign.template_name}" (normalized="${normalizedTemplateName}") language="${lang}". Use the exact Meta template name (usually lowercase_with_underscores).`,
            meta: { found: templates.map(t => ({ name: t.name, language: t.language, status: t.status })) }
          });
        }
        if (String(match.status || '').toUpperCase() !== 'APPROVED') {
          return res.status(400).json({
            success: false,
            message: `Meta template is not approved (status=${match.status}). Wait for approval or use an approved template.`,
            meta: { name: match.name, language: match.language, status: match.status }
          });
        }
      } else {
        console.warn('⚠️ Template preflight skipped (missing WABA_ID/TOKEN/template_name)');
      }
    } catch (e) {
      console.error('⚠️ Template preflight error (continuing):', e.response?.data || e.message);
      // Don't block sending if Meta list endpoint fails; the actual send will provide the real error.
    }

    if (campaign.status === 'draft') {
      let audienceCount = await CampaignAudience.count({ where: { campaignId } });

      // Allow starting directly by passing audience/contactIds in start payload.
      if (audienceCount === 0) {
        const body = req.body || {};
        const contactIds = [
          ...normalizeContactIdsFromPayload(body.contactIds),
          ...normalizeContactIdsFromPayload(body.contact_ids),
          ...normalizeContactIdsFromPayload(body.contacts),
          ...normalizeContactIdsFromPayload(body.audience_ids),
          ...normalizeContactIdsFromPayload(body.audienceIds)
        ];
        const audience =
          normalizeAudienceFromPayload(body.audience).length > 0
            ? normalizeAudienceFromPayload(body.audience)
            : normalizeAudienceFromPayload(body.recipients);
        const incomingMapping =
          (body.variable_mapping && typeof body.variable_mapping === 'object' && body.variable_mapping) ||
          (body.variableMapping && typeof body.variableMapping === 'object' && body.variableMapping) ||
          (body.mapping && typeof body.mapping === 'object' && body.mapping) ||
          null;
        const effectiveMapping = incomingMapping || (campaign.variable_mapping && typeof campaign.variable_mapping === 'object' ? campaign.variable_mapping : null);

        if (contactIds.length > 0) {
          const uniqueContactIds = Array.from(new Set(contactIds));
          const contacts = await Contact.findAll({
            where: { id: uniqueContactIds, userId, projectId },
            attributes: ['id', 'phone', 'name', 'customFields']
          });

          const uniquePhones = new Set();
          const audienceRecords = contacts
            .filter((c) => {
              const key = String(c.phone || '').trim();
              if (!key || uniquePhones.has(key)) return false;
              uniquePhones.add(key);
              return true;
            })
            .map((c) => {
              const v = buildAudienceVars(c, effectiveMapping);
              return {
                campaignId,
                phone: normalizeCampaignAudiencePhone(c.phone),
                var1: v.var1, var2: v.var2, var3: v.var3, var4: v.var4, var5: v.var5,
                status: 'pending'
              };
            });

          if (audienceRecords.length > 0) {
            await CampaignAudience.bulkCreate(audienceRecords);
            if (incomingMapping) {
              campaign.variable_mapping = incomingMapping;
              await campaign.save();
            }
          }
        } else if (audience.length > 0) {
          const audienceRecords = audience
            .filter(aud => aud && aud.phone)
            .map(aud => ({
              campaignId,
              phone: normalizeCampaignAudiencePhone(aud.phone),
              var1: aud.var1 || null,
              var2: aud.var2 || null,
              var3: aud.var3 || null,
              var4: aud.var4 || null,
              var5: aud.var5 || null,
              status: 'pending'
            }));
          if (audienceRecords.length > 0) {
            await CampaignAudience.bulkCreate(audienceRecords);
          }
        } else {
          // Last-resort fallback: if no payload audience is passed, start with all active contacts in project.
          const contacts = await Contact.findAll({
            where: accountWideContactWhere(userId, projectId, { status: 'active' }),
            attributes: ['id', 'phone', 'name', 'customFields']
          });
          const uniquePhones = new Set();
          const audienceRecords = contacts
            .filter((c) => {
              const key = String(c.phone || '').trim();
              if (!key || uniquePhones.has(key)) return false;
              uniquePhones.add(key);
              return true;
            })
            .map((c) => {
              const v = buildAudienceVars(c, effectiveMapping);
              return {
                campaignId,
                phone: normalizeCampaignAudiencePhone(c.phone),
                var1: v.var1, var2: v.var2, var3: v.var3, var4: v.var4, var5: v.var5,
                status: 'pending'
              };
            });
          if (audienceRecords.length > 0) {
            await CampaignAudience.bulkCreate(audienceRecords);
          }
        }

        audienceCount = await CampaignAudience.count({ where: { campaignId } });
      }

      if (audienceCount === 0) {
        return res.status(400).json({
          success: false,
          message: 'Add audience before sending: call /campaigns/:id/contacts or pass contactIds + variable_mapping (or audience[]) in this start request'
        });
      }
      campaign.status = 'PENDING';
      campaign.total = audienceCount;
      campaign.totalRecipients = audienceCount;
      await campaign.save();
    }

    const startPaused = req.body?.startPaused === true || req.body?.start_paused === true;

    const billingCategory = await resolveCampaignTemplateBillingCategory(campaign, userId, projectId);
    const ownerId = await Project.getProjectOwnerId(projectId);
    const walletCurrency = await getWalletCurrencyForOwner(ownerId || userId);
    const campaignContacts = await getCampaignContacts(campaignId);
    const costResult = await calculateCampaignCost({
      contacts: campaignContacts,
      category: billingCategory,
      walletCurrency,
      ownerUserId: ownerId || userId,
    });
    const balance = await Project.getWccCredits(projectId, ownerId || userId);
    if (Number(balance) < Number(costResult.total)) {
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_WCC',
        message: 'Insufficient WCC balance',
        required: costResult.total,
        available: balance,
        currency: costResult.currency,
        breakdown: costResult.breakdown,
      });
    }

    // Optional: allow creating audience now but delaying send until resume is called.
    if (startPaused) {
      campaign.status = 'PAUSED';
      await campaign.save();
      return res.json({
        success: true,
        message: 'Campaign prepared and paused successfully',
        campaignId: campaign.id,
        status: campaign.status
      });
    }

    // Update status to PROCESSING
    campaign.status = 'PROCESSING';
    await campaign.save();

    // Start processing in background (don't await)
    processCampaign(campaignId, userId, projectId).catch(err => {
      console.error('Error processing campaign:', err);
    });

    res.json({
      success: true,
      message: 'Campaign started successfully',
      campaignId: campaign.id,
      status: campaign.status
    });
  } catch (error) {
    console.error('Error starting campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Pause Campaign
exports.pauseCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const campaign = await Campaign.findOne({
      where: {
        id: campaignId,
        userId,
        projectId
      }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    if (!['PROCESSING', 'PENDING'].includes(campaign.status)) {
      return res.status(400).json({
        success: false,
        message: 'Campaign is not in a pausable state',
        currentStatus: campaign.status
      });
    }

    // Stop processor if active
    if (activeProcessors.has(campaignId)) {
      stopCampaignProcessor(campaignId);
    }

    campaign.status = 'PAUSED';
    await campaign.save();

    res.json({
      success: true,
      message: 'Campaign paused successfully',
      campaignId: campaign.id,
      status: campaign.status
    });
  } catch (error) {
    console.error('Error pausing campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Resume Campaign
exports.resumeCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const campaign = await Campaign.findOne({
      where: {
        id: campaignId,
        userId,
        projectId
      }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    if (campaign.status !== 'PAUSED') {
      return res.status(400).json({
        success: false,
        message: 'Campaign is not paused'
      });
    }

    // Update status to PROCESSING
    campaign.status = 'PROCESSING';
    await campaign.save();

    // Resume processing in background
    processCampaign(campaignId, userId, projectId).catch(err => {
      console.error('Error resuming campaign:', err);
    });

    res.json({
      success: true,
      message: 'Campaign resumed successfully',
      campaignId: campaign.id,
      status: campaign.status
    });
  } catch (error) {
    console.error('Error resuming campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

const RECHURN_AUDIENCE_STATUS = {
  failed: { status: 'failed' },
  sent: { status: { [Op.in]: ['sent', 'delivered', 'read'] } },
  delivered: { status: { [Op.in]: ['delivered', 'read'] } },
  read: { status: 'read' },
};

// Audience + campaign name for rebroadcasting by delivery status (failed, sent, delivered, read)
exports.getCampaignRetryPrefill = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;
    const recipientStatus = String(req.query.status || 'failed').trim().toLowerCase();

    if (!RECHURN_AUDIENCE_STATUS[recipientStatus]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid recipient status. Use failed, sent, delivered, or read.',
      });
    }

    const campaign = await Campaign.findOne({
      where: { id: campaignId, userId, projectId },
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found',
      });
    }

    const audienceRows = await CampaignAudience.findAll({
      where: { campaignId, ...RECHURN_AUDIENCE_STATUS[recipientStatus] },
      order: [['id', 'ASC']],
      attributes: ['phone', 'var1', 'var2', 'var3', 'var4', 'var5'],
    });

    if (!audienceRows.length) {
      return res.status(400).json({
        success: false,
        message: `No ${recipientStatus} recipients found for this campaign`,
      });
    }

    const audience = audienceRows.map((row) => {
      const plain = row.get({ plain: true });
      return {
        phone: plain.phone,
        var1: plain.var1 || null,
        var2: plain.var2 || null,
        var3: plain.var3 || null,
        var4: plain.var4 || null,
        var5: plain.var5 || null,
      };
    });

    res.json({
      success: true,
      sourceCampaignId: campaign.id,
      sourceCampaignName: campaign.name,
      recipientStatus,
      recipientCount: audience.length,
      failedCount: audience.length,
      name: `${campaign.name} (${recipientStatus} retry)`,
      variable_mapping: campaign.variable_mapping || null,
      audience,
    });
  } catch (error) {
    console.error('Error fetching campaign retry prefill:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

// Audience who replied after campaign delivery (smart segregation)
exports.getCampaignReplies = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const hoursRaw = req.query.hours;
    const hours =
      hoursRaw == null || String(hoursRaw).trim() === ''
        ? null
        : parseInt(String(hoursRaw), 10);
    if (hours != null && !VALID_REPLY_HOUR_WINDOWS.includes(hours)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid hours window. Use 1, 3, or 24.',
      });
    }

    const campaign = await Campaign.findOne({
      where: { id: campaignId, userId, projectId },
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found',
      });
    }

    const audience = await buildCampaignReplyAudience({
      campaignId,
      userId,
      projectId,
      hours,
    });

    res.json({
      success: true,
      sourceCampaignId: campaign.id,
      sourceCampaignName: campaign.name,
      hours,
      replyCount: audience.length,
      variable_mapping: campaign.variable_mapping || null,
      audience,
    });
  } catch (error) {
    console.error('Error fetching campaign replies:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

// Get Campaign Audience Logs
exports.getCampaignAudience = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaignId = req.params.id;

    const campaign = await Campaign.findOne({
      where: {
        id: campaignId,
        userId,
        projectId
      }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    const rows = await CampaignAudience.findAll({
      where: { campaignId },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'phone', 'var1', 'var2', 'var3', 'var4', 'var5', 'status', 'waMessageId', 'errorMessage', 'sentAt', 'deliveredAt', 'readAt']
    });

    const audience = rows.map((row) => {
      const plain = row.get({ plain: true });
      if (
        plain.waMessageId &&
        ['sent', 'delivered', 'read'].includes(String(plain.status || '').toLowerCase())
      ) {
        plain.errorMessage = null;
      }
      return plain;
    });

    res.json({
      success: true,
      audience
    });
  } catch (error) {
    console.error('Error fetching campaign audience:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Update Campaign (edit campaign details)
exports.updateCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const campaignId = req.params.id;
    const { name, template_name, template_language, schedule_time, status } = req.body;

    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaign = await Campaign.findOne({ where: { id: campaignId, userId, projectId } });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    // Prevent edits while processing/completed (safe default)
    if (campaign.status === 'PROCESSING') {
      return res.status(400).json({ success: false, message: 'Cannot edit campaign while it is processing' });
    }
    if (campaign.status === 'COMPLETED') {
      return res.status(400).json({ success: false, message: 'Cannot edit a completed campaign' });
    }

    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof template_name === 'string' && template_name.trim()) updates.template_name = template_name.trim();
    if (typeof template_language === 'string' && template_language.trim()) updates.template_language = template_language.trim();
    if (schedule_time === null || schedule_time === '' || schedule_time === undefined) {
      // allow clearing schedule
      updates.schedule_time = null;
    } else if (schedule_time) {
      updates.schedule_time = new Date(schedule_time);
    }

    // Optional: allow setting status to draft/PENDING/PAUSED only (avoid invalid transitions)
    if (status && ['draft', 'PENDING', 'PAUSED'].includes(status)) {
      updates.status = status;
    }

    await campaign.update(updates);

    return res.json({
      success: true,
      campaign: campaign.toJSON()
    });
  } catch (error) {
    console.error('Error updating campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Delete Campaign
exports.deleteCampaign = async (req, res) => {
  try {
    const userId = req.user.id;
    const campaignId = req.params.id;

    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const campaign = await Campaign.findOne({ where: { id: campaignId, userId, projectId } });
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    if (campaign.status === 'PROCESSING') {
      return res.status(400).json({ success: false, message: 'Pause the campaign before deleting' });
    }

    // Clean up audiences first (safe even if FK cascade not enforced)
    await CampaignAudience.destroy({ where: { campaignId } });
    await Campaign.destroy({ where: { id: campaignId, userId, projectId } });

    return res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Process Campaign - Core Brain (Batch sending logic)
async function processCampaign(campaignId, userId, projectId) {
  try {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign || campaign.status !== 'PROCESSING') {
      return;
    }

    const normalizeMetaTemplateName = (name) => {
      if (!name) return '';
      return String(name)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    };

    const waCandidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
    if (!waCandidates.some((c) => c?.phoneNumberId && c?.accessToken)) {
      console.error('❌ Missing API credentials for campaign processing');
      campaign.status = 'PAUSED';
      await campaign.save();
      return;
    }

    // Resolve Meta-approved template structure (header format + body variable count).
    let sendSpec = null;
    let loadedTemplate = null;
    let effectiveTemplateLanguage = campaign.template_language || 'en_US';
    let metaComponents = [];
    try {
      loadedTemplate = await loadTemplateRecordForCampaign({
        userId,
        projectId,
        templateName: campaign.template_name,
      });
      metaComponents = await resolveTemplateComponentsForSend(loadedTemplate || {}, {
        userId,
        projectId,
        templateName: campaign.template_name,
      });
      const metaTpl = await fetchMetaTemplateByName(campaign.template_name, userId, projectId);
      effectiveTemplateLanguage =
        metaTpl?.language ||
        campaign.template_language ||
        (loadedTemplate?.variables &&
        typeof loadedTemplate.variables === 'object' &&
        !Array.isArray(loadedTemplate.variables) &&
        loadedTemplate.variables.language
          ? String(loadedTemplate.variables.language)
          : null) ||
        effectiveTemplateLanguage;
      effectiveTemplateLanguage = String(effectiveTemplateLanguage || 'en_US').trim();
      if (!metaComponents.length && Array.isArray(metaTpl?.components) && metaTpl.components.length) {
        metaComponents = metaTpl.components;
      }
      sendSpec = applyCampaignHeaderHint(
        parseTemplateSendSpec(metaComponents, loadedTemplate?.content || '', {
          templateType:
            loadedTemplate?.variables &&
            typeof loadedTemplate.variables === 'object' &&
            !Array.isArray(loadedTemplate.variables)
              ? loadedTemplate.variables.templateType
              : null,
        }),
        campaign
      );
      console.log('📋 Campaign template send spec', {
        campaignId,
        template: campaign.template_name,
        language: effectiveTemplateLanguage,
        headerFormat: sendSpec.headerFormat,
        bodyVarNums: sendSpec.bodyVarNums,
        needsHeaderMedia: sendSpec.needsHeaderMedia,
        metaButtonCount: extractButtonsFromComponents(metaComponents).length,
      });
    } catch (e) {
      console.error('Failed to resolve template send spec:', e.message);
      sendSpec = parseTemplateSendSpec(
        loadedTemplate ? getTemplateComponents(loadedTemplate) : [],
        loadedTemplate?.content || ''
      );
    }

    const campaignHeaderMediaUrl = toPublicMediaUrl(campaign.header_media_url);
    if (sendSpec?.needsHeaderMedia && !campaignHeaderMediaUrl) {
      console.warn(
        `⚠️ Campaign ${campaignId} image/video template without header_media_url — sends may fail`
      );
    }

    let campaignHeaderMediaId = null;
    let campaignHeaderMediaPhoneId = null;
    if (sendSpec?.needsHeaderMedia && campaignHeaderMediaUrl) {
      const headerMediaSource = campaign.header_media_url || campaignHeaderMediaUrl;
      try {
        const uploaded = await resolveHeaderMediaIdForSend(
          waCandidates,
          headerMediaSource,
          sendSpec.headerFormat
        );
        if (uploaded?.mediaId) {
          campaignHeaderMediaId = uploaded.mediaId;
          campaignHeaderMediaPhoneId = uploaded.phoneNumberId || null;
        }
      } catch (uploadErr) {
        console.warn(
          `Campaign ${campaignId} header media upload failed:`,
          uploadErr?.message || uploadErr
        );
      }
      if (!campaignHeaderMediaId) {
        const { resolveLocalMediaPath } = require('../services/templateHeaderSendService');
        const localPath =
          resolveLocalMediaPath(headerMediaSource) || resolveLocalMediaPath(campaignHeaderMediaUrl);
        if (!localPath) {
          console.warn(
            `Campaign ${campaignId}: header media not found on disk (${headerMediaSource}); will retry upload per recipient`
          );
        }
      }
      if (!campaignHeaderMediaId && !campaignHeaderMediaUrl) {
        campaign.status = 'PAUSED';
        await campaign.save();
        console.error(`❌ Campaign ${campaignId} paused: image template requires header media`);
        return;
      }
    }

    const CAMPAIGN_BATCH_SIZE = 50;
    const CAMPAIGN_SEND_CONCURRENCY = 25;
    const templateBillingCategory = await resolveCampaignTemplateBillingCategory(campaign, userId, projectId);

    const getPendingBatch = async () => {
      return await CampaignAudience.findAll({
        where: {
          campaignId,
          status: 'pending'
        },
        limit: CAMPAIGN_BATCH_SIZE,
        order: [['id', 'ASC']]
      });
    };

    const processAudienceMember = async (audienceMember) => {
      try {
        const checkCampaign = await Campaign.findByPk(campaignId);
        if (!checkCampaign || checkCampaign.status !== 'PROCESSING') {
          return;
        }

        const normalizedPhoneNumber = normalizeCampaignAudiencePhone(audienceMember.phone);
        if (!normalizedPhoneNumber || normalizedPhoneNumber.length < 10) {
          audienceMember.status = 'failed';
          audienceMember.errorMessage = `Invalid phone number: "${audienceMember.phone}"`;
          await audienceMember.save();
          await Campaign.increment('failed', { where: { id: campaignId } });
          return;
        }
        if (audienceMember.phone !== normalizedPhoneNumber) {
          audienceMember.phone = normalizedPhoneNumber;
          await audienceMember.save();
        }

        const normalizedTemplateName = normalizeMetaTemplateName(campaign.template_name);
        if (!normalizedTemplateName) {
          audienceMember.status = 'failed';
          audienceMember.errorMessage = `Invalid template name: "${campaign.template_name}"`;
          await audienceMember.save();
          await Campaign.increment('failed', { where: { id: campaignId } });
          return;
        }

        if (sendSpec?.needsHeaderMedia && !campaignHeaderMediaUrl) {
          audienceMember.status = 'failed';
          audienceMember.errorMessage = 'Template requires header image/media but none was uploaded for this campaign';
          await audienceMember.save();
          await Campaign.increment('failed', { where: { id: campaignId } });
          return;
        }

        const billing = await upsertConversationWithQuota(userId, normalizedPhoneNumber);
        if (!billing.allowed) {
          audienceMember.status = 'failed';
          audienceMember.errorMessage = 'Blocked (conversation limit reached)';
          await audienceMember.save();
          await Campaign.increment('failed', { where: { id: campaignId } });
          return;
        }

        const wccCheck = await requireWccForOutgoing(projectId, billing, {
          isTemplate: true,
          customerPhone: normalizedPhoneNumber,
          billingCategory: templateBillingCategory,
          userId,
        });
        if (!wccCheck.ok) {
          audienceMember.status = 'failed';
          audienceMember.errorMessage =
            `Insufficient WCC (need ${wccCheck.charge}, have ${wccCheck.balance})`;
          await audienceMember.save();
          await Campaign.increment('failed', { where: { id: campaignId } });
          return;
        }

        let response;
        let usedCreds;
        try {
          ({ response, creds: usedCreds } = await sendCampaignTemplateWithRetries({
            waCandidates,
            sendSpec,
            metaComponents,
            campaign,
            campaignHeaderMediaUrl,
            cachedHeaderMediaId: campaignHeaderMediaId,
            cachedHeaderMediaPhoneId: campaignHeaderMediaPhoneId,
            audienceMember,
            normalizedTemplateName,
            effectiveTemplateLanguage,
            normalizedPhoneNumber,
            userId,
            projectId,
            templateBillingCategory,
          }));
        } catch (componentErr) {
          if (
            String(componentErr?.message || '').includes('Header') &&
            String(componentErr?.message || '').includes('required')
          ) {
            audienceMember.status = 'failed';
            audienceMember.errorMessage =
              componentErr.message || 'Failed to build template components';
            await audienceMember.save();
            await Campaign.increment('failed', { where: { id: campaignId } });
            return;
          }
          throw componentErr;
        }

        const waMessageId = response.data.messages?.[0]?.id || null;

        audienceMember.status = 'sent';
        audienceMember.waMessageId = waMessageId;
        audienceMember.sentAt = new Date();
        audienceMember.errorMessage = null;
        await audienceMember.save();

        setImmediate(() => {
          (async () => {
            try {
              const contact = await findOrCreateCampaignContact({
                userId,
                projectId,
                phone: normalizedPhoneNumber || audienceMember.phone,
              });

              const bodyParams = buildBodyParamsFromAudience(
                sendSpec?.bodyVarNums || [],
                audienceMember
              );
              const clientPreview = buildClientTemplatePreview(
                enrichTemplateRecordWithComponents(loadedTemplate, metaComponents),
                loadedTemplate?.content || '',
                {
                  templateName: campaign.template_name,
                  templateParams: bodyParams,
                  headerImageUrl: campaign.header_media_url,
                }
              );
              const snapshotForInbox = finalizeTemplateSnapshotForInbox(
                clientPreview,
                {
                  template: {
                    name: normalizedTemplateName,
                    language: { code: effectiveTemplateLanguage },
                  },
                },
                campaign.header_media_url
              );
              await InboxMessage.create({
                contactId: contact.id,
                userId,
                projectId,
                direction: 'outgoing',
                message: snapshotForInbox?.body || loadedTemplate?.content || `Template: ${campaign.template_name}`,
                type: 'text',
                status: 'sent',
                isTemplateSend: true,
                templateName: campaign.template_name,
                templateSnapshot: snapshotForInbox ? JSON.stringify(snapshotForInbox) : null,
                mediaUrl: snapshotForInbox?.headerImageUrl || snapshotForInbox?.header?.url || null,
                waMessageId: waMessageId,
                timestamp: new Date(),
              });

              await seedFlowSessionForCampaignTemplate({
                contact,
                userId,
                projectId,
                templateName: campaign.template_name,
                phone: normalizedPhoneNumber || audienceMember.phone,
              });
            } catch (postSendErr) {
              console.error(
                `Post-send contact/inbox sync failed (campaign ${campaignId}, to ${audienceMember.phone}):`,
                postSendErr?.message || postSendErr
              );
            }
          })();
        });

        await Campaign.increment('sent', { where: { id: campaignId } });
      } catch (apiError) {
        const metaErrorPayload = apiError.response?.data;
        console.error(`❌ Meta send failed (campaign ${campaignId}, to ${audienceMember.phone})`, {
          message: apiError.message,
          status: apiError.response?.status,
          data: metaErrorPayload
        });

        audienceMember.status = 'failed';
        audienceMember.errorMessage =
          formatMetaApiErrorMessage(apiError) ||
          metaErrorPayload?.error?.message ||
          metaErrorPayload?.message ||
          apiError.message ||
          'Unknown error';
        await audienceMember.save();

        await Campaign.increment('failed', { where: { id: campaignId } });
      }
    };

    const pumpHandle = { stop: false };
    activeProcessors.set(campaignId, pumpHandle);

    const runCampaignPump = async () => {
      while (!pumpHandle.stop) {
        const currentCampaign = await Campaign.findByPk(campaignId);
        if (!currentCampaign || currentCampaign.status !== 'PROCESSING') {
          stopCampaignProcessor(campaignId);
          return;
        }

        const batch = await getPendingBatch();
        if (batch.length === 0) {
          campaign.status = 'COMPLETED';
          campaign.completedAt = new Date();
          await campaign.save();
          stopCampaignProcessor(campaignId);
          console.log(`✅ Campaign ${campaignId} completed`);
          return;
        }

        await runWithConcurrency(batch, CAMPAIGN_SEND_CONCURRENCY, processAudienceMember);
        await updateCampaignStats(campaignId);
      }
    };

    runCampaignPump().catch((pumpErr) => {
      console.error(`Campaign ${campaignId} pump error:`, pumpErr?.message || pumpErr);
      stopCampaignProcessor(campaignId);
    });

  } catch (error) {
    console.error('Error in processCampaign:', error);
    if (!activeProcessors.has(campaignId)) {
      const campaign = await Campaign.findByPk(campaignId);
      if (campaign && campaign.status === 'PROCESSING') {
        campaign.status = 'PAUSED';
        await campaign.save();
      }
    }
    if (activeProcessors.has(campaignId)) {
      stopCampaignProcessor(campaignId);
    }
  }
}

// Update campaign stats from audience
async function updateCampaignStats(campaignId) {
  try {
    const stat = await calculateCampaignAudienceStats(campaignId);
    await Campaign.update({
      total: parseInt(stat.total, 10) || 0,
      sent: parseInt(stat.sent, 10) || 0,
      delivered: parseInt(stat.delivered, 10) || 0,
      read: parseInt(stat.read, 10) || 0,
      failed: parseInt(stat.failed, 10) || 0
    }, { where: { id: campaignId } });
  } catch (error) {
    console.error('Error updating campaign stats:', error);
    // Fallback: count manually
    try {
      const sent = await CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['sent', 'delivered', 'read'] } } });
      const delivered = await CampaignAudience.count({ where: { campaignId, status: { [Op.in]: ['delivered', 'read'] } } });
      const read = await CampaignAudience.count({ where: { campaignId, status: 'read' } });
      const failed = await CampaignAudience.count({ where: { campaignId, status: 'failed' } });
      
      await Campaign.update({
        sent,
        delivered,
        read,
        failed
      }, { where: { id: campaignId } });
    } catch (fallbackError) {
      console.error('Error in fallback stats update:', fallbackError);
    }
  }
}

exports.runDueScheduledCampaigns = async () => {
  const now = new Date();
  const due = await Campaign.findAll({
    where: {
      status: 'scheduled',
      schedule_time: { [Op.lte]: now },
    },
    limit: 20,
  });

  for (const campaign of due) {
    try {
      const fresh = await Campaign.findByPk(campaign.id);
      if (!fresh || fresh.status !== 'scheduled') continue;
      fresh.status = 'PROCESSING';
      await fresh.save();
      processCampaign(fresh.id, fresh.userId, fresh.projectId).catch((err) => {
        console.error(`Scheduled campaign ${fresh.id} process error:`, err);
      });
      console.log(`✅ Started scheduled campaign ${fresh.id} (${fresh.name})`);
    } catch (e) {
      console.error(`Failed to start scheduled campaign ${campaign.id}:`, e.message);
    }
  }
};

exports.estimateCampaignCost = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const ownerId = await Project.getProjectOwnerId(projectId);
    const walletCurrency = await getWalletCurrencyForOwner(ownerId || userId);
    const balance = await Project.getWccCredits(projectId, ownerId || userId);

    const body = req.body || {};
    const campaignId = body.campaignId || body.campaign_id || req.params?.id || null;
    let billingCategory = body.category || body.billingCategory || body.billing_category || null;

    let costResult;
    if (campaignId) {
      const campaign = await Campaign.findOne({
        where: { id: campaignId, userId, projectId },
      });
      if (!campaign) {
        return res.status(404).json({ success: false, message: 'Campaign not found' });
      }
      billingCategory =
        billingCategory || (await resolveCampaignTemplateBillingCategory(campaign, userId, projectId));
      const contacts = await getCampaignContacts(campaignId);
      costResult = await calculateCampaignCost({
        contacts,
        category: billingCategory,
        walletCurrency,
        ownerUserId: ownerId || userId,
      });
    } else {
      const phones = Array.isArray(body.phones)
        ? body.phones
        : Array.isArray(body.audience)
          ? body.audience.map((row) => row?.phone || row).filter(Boolean)
          : [];
      billingCategory = billingCategory || 'marketing';
      costResult = await calculateCampaignCostByPhones({
        phones,
        category: billingCategory,
        walletCurrency,
        ownerUserId: ownerId || userId,
      });
    }

    return res.json({
      success: true,
      balance: Number(balance),
      estimatedCost: costResult.total,
      currency: costResult.currency,
      billingCategory: costResult.billingCategory,
      sufficientBalance: Number(balance) >= Number(costResult.total),
      contactCount: costResult.contactCount,
      breakdown: costResult.breakdown,
    });
  } catch (error) {
    console.error('Campaign cost estimate error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to estimate campaign cost',
    });
  }
};

exports.calculateCampaignCost = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const ownerId = await Project.getProjectOwnerId(projectId);
    const body = req.body || {};

    const contacts = Array.isArray(body.contacts)
      ? body.contacts
      : Array.isArray(body.audience)
        ? body.audience
        : Array.isArray(body.phones)
          ? body.phones.map((phone) => ({ phone }))
          : [];

    const category =
      body.category ||
      body.templateCategory ||
      body.billingCategory ||
      body.billing_category ||
      null;

    if (!contacts.length) {
      return res.status(400).json({ success: false, message: 'Contacts are required' });
    }
    if (!category) {
      return res.status(400).json({ success: false, message: 'Template category is required' });
    }

    const walletCurrency =
      body.currency ||
      body.customerCurrency ||
      (await getWalletCurrencyForOwner(ownerId || userId));

    const pricing = await calculateCampaignPricingSummary({
      contacts,
      category,
      currency: walletCurrency,
    });

    const balance = await Project.getWccCredits(projectId, ownerId || userId);
    const remainingBalance = roundCampaignAmount(Number(balance) - Number(pricing.totalAmount));

    return res.json({
      success: true,
      currency: pricing.currency,
      category: pricing.category,
      countries: pricing.countries,
      totalAmount: pricing.totalAmount,
      contactCount: pricing.contactCount,
      balance: Number(balance),
      remainingBalance,
      sufficientBalance: Number(balance) >= Number(pricing.totalAmount),
    });
  } catch (error) {
    console.error('Campaign cost calculation error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to calculate campaign cost',
    });
  }
};

function roundCampaignAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
