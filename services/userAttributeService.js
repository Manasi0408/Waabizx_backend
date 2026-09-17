const Contact = require('../models/Contact');
const { UserAttribute } = require('../models');

const normalizeName = (name) => String(name || '').trim();

async function stripAttributeFromProjectContacts(projectId, attributeName) {
  const key = normalizeName(attributeName);
  if (!projectId || !key) return;

  const contacts = await Contact.findAll({
    where: { projectId: Number(projectId) },
    attributes: ['id', 'customFields'],
  });

  for (const contact of contacts) {
    const raw = contact.customFields;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const next = { ...raw };
    delete next[key];
    await contact.update({ customFields: next });
  }
}

async function listUserAttributes(projectId) {
  return UserAttribute.findAll({
    where: { projectId },
    order: [['name', 'ASC']],
  });
}

async function saveUserAttributes(projectId, userId, attributes = []) {
  if (!projectId) {
    const err = new Error('Project is required');
    err.status = 400;
    throw err;
  }

  const normalized = (Array.isArray(attributes) ? attributes : [])
    .map((item) => ({
      id: item?.id,
      name: normalizeName(item?.name),
    }))
    .filter((item) => item.name);

  const lowerNames = normalized.map((item) => item.name.toLowerCase());
  if (new Set(lowerNames).size !== lowerNames.length) {
    const err = new Error('Attribute names must be unique');
    err.status = 400;
    throw err;
  }

  const existing = await UserAttribute.findAll({ where: { projectId } });
  const keepIds = new Set();

  for (const item of normalized) {
    const numId = Number(item.id);
    if (Number.isInteger(numId) && numId > 0) {
      const row = existing.find((entry) => Number(entry.id) === numId);
      if (row) {
        await row.update({ name: item.name });
        keepIds.add(row.id);
        continue;
      }
    }
    const created = await UserAttribute.create({
      projectId,
      name: item.name,
      createdBy: userId || null,
    });
    keepIds.add(created.id);
  }

  for (const row of existing) {
    if (!keepIds.has(row.id)) {
      const removedName = row.name;
      await row.destroy();
      await stripAttributeFromProjectContacts(projectId, removedName);
    }
  }

  return listUserAttributes(projectId);
}

module.exports = {
  listUserAttributes,
  saveUserAttributes,
};
