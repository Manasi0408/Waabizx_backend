const { Op } = require('sequelize');
const { CampaignAudience, Contact } = require('../models');
const { getMessageCost } = require('./whatsappPricingService');
const { getWalletCurrencyForOwner } = require('./wccCountryPricingService');
const { getCountryFromPhone } = require('../utils/phoneUtils');
const { detectCountryFromPhone, normalizeBillingCategory, maybePersistContactCountryCode } = require('./wccCountryPricingService');
const { normalizeCountryCode } = require('../utils/geoCountry');
const { phoneVariantsForLookup } = require('../utils/phoneNormalize');

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function resolveContactCountryCode(contact) {
  const fromField =
    normalizeCountryCode(contact?.country_code) ||
    normalizeCountryCode(contact?.country) ||
    normalizeCountryCode(contact?.get?.('country_code')) ||
    normalizeCountryCode(contact?.get?.('country'));
  if (fromField) return fromField;
  const fromPhone = getCountryFromPhone(contact?.phone);
  if (fromPhone) return fromPhone;
  return detectCountryFromPhone(contact?.phone);
}

async function enrichContactsWithCountry(contacts = []) {
  const enriched = [];
  for (const raw of contacts) {
    const phone = String(raw?.phone || '').trim();
    if (!phone) continue;

    let countryCode =
      normalizeCountryCode(raw?.country_code) ||
      normalizeCountryCode(raw?.country);

    let contactId = raw?.id || raw?.contactId || null;

    if (!countryCode) {
      const variants = phoneVariantsForLookup(phone);
      const contact = await Contact.findOne({
        where: { phone: { [Op.in]: variants } },
        order: [['updatedAt', 'DESC']],
        attributes: ['id', 'phone', 'country_code', 'country'],
      });
      if (contact) {
        contactId = contact.id;
        countryCode = resolveContactCountryCode(contact);
        await maybePersistContactCountryCode(contact.id, countryCode);
      }
    }

    if (!countryCode) {
      countryCode = getCountryFromPhone(phone) || detectCountryFromPhone(phone);
    }

    if (!countryCode) {
      throw new Error(`Country not found for contact ${contactId || phone}`);
    }

    enriched.push({
      id: contactId,
      phone,
      country_code: countryCode,
    });
  }
  return enriched;
}

async function getCampaignContacts(campaignId) {
  const rows = await CampaignAudience.findAll({
    where: { campaignId },
    attributes: ['phone'],
  });
  return enrichContactsWithCountry(rows.map((row) => ({ phone: row.phone })));
}

async function calculateCampaignCost({ contacts, category, walletCurrency, ownerUserId = null }) {
  const walletCur = String(
    walletCurrency ||
      (ownerUserId ? await getWalletCurrencyForOwner(ownerUserId) : null) ||
      'INR'
  ).toUpperCase();
  const billingCategory = normalizeBillingCategory(category);
  const list = await enrichContactsWithCountry(Array.isArray(contacts) ? contacts : []);

  const countryGroups = {};
  for (const contact of list) {
    const country = contact.country_code;
    countryGroups[country] = (countryGroups[country] || 0) + 1;
  }

  let total = 0;
  const breakdown = [];

  for (const [country, count] of Object.entries(countryGroups)) {
    const pricing = await getMessageCost({
      countryCode: country,
      category: billingCategory,
      walletCurrency: walletCur,
    });
    const countryTotal = roundAmount(pricing.walletPrice * count);
    total += countryTotal;
    breakdown.push({
      country,
      count,
      pricePerMessage: pricing.walletPrice,
      originalPrice: pricing.originalPrice,
      originalCurrency: pricing.originalCurrency,
      currency: walletCur,
      total: countryTotal,
    });
  }

  return {
    total: roundAmount(total),
    currency: walletCur,
    billingCategory,
    contactCount: list.length,
    breakdown,
  };
}

async function calculateCampaignCostByPhones({ phones, category, walletCurrency, ownerUserId = null }) {
  const list = (Array.isArray(phones) ? phones : [])
    .filter(Boolean)
    .map((phone) => ({ phone: String(phone).trim() }));
  return calculateCampaignCost({
    contacts: list,
    category,
    walletCurrency,
    ownerUserId,
  });
}

module.exports = {
  enrichContactsWithCountry,
  getCampaignContacts,
  calculateCampaignCost,
  calculateCampaignCostByPhones,
};
