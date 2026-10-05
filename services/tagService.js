const { Op } = require('sequelize');
const { Tag, ContactTag, Contact } = require('../models');
const {
  normalizeWhatsAppRecipient,
  phoneVariantsForLookup,
} = require('../utils/phoneNormalize');

const normalizeTagName = (name) => String(name || '').trim();

async function resolveContactForTags({ contactId, phone, userId, projectId, createIfMissing = true }) {
  if (!projectId) {
    const err = new Error('Project is required');
    err.status = 400;
    throw err;
  }

  const variants = phone ? phoneVariantsForLookup(phone) : [];

  if (variants.length) {
    let contact = await Contact.findOne({
      where: { phone: { [Op.in]: variants }, projectId },
    });

    if (!contact && userId) {
      contact = await Contact.findOne({
        where: { phone: { [Op.in]: variants }, userId, projectId: null },
      });
      if (contact) {
        await contact.update({ projectId });
        await contact.reload();
      }
    }

    if (contact) return contact;

    if (createIfMissing && userId) {
      const normalizedPhone = normalizeWhatsAppRecipient(phone) || String(phone || '').trim();
      try {
        contact = await Contact.create({
          userId,
          projectId,
          phone: normalizedPhone,
          name: normalizedPhone,
          status: 'active',
        });
        return contact;
      } catch (createErr) {
        if (
          createErr?.name === 'SequelizeUniqueConstraintError' ||
          /duplicate/i.test(createErr?.message || '')
        ) {
          contact = await Contact.findOne({
            where: { phone: { [Op.in]: variants }, projectId },
          });
          if (contact) return contact;
        }
        throw createErr;
      }
    }
  }

  const numericId = Number(contactId);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byId = await Contact.findOne({
      where: { id: numericId, projectId },
    });
    if (byId) return byId;
  }

  const err = new Error('Contact not found');
  err.status = 404;
  throw err;
}

async function listTags(projectId) {
  return Tag.findAll({
    where: { projectId },
    order: [['name', 'ASC']],
  });
}

async function createTag({ projectId, name, color, createdBy }) {
  const trimmed = normalizeTagName(name);
  if (!trimmed) {
    const err = new Error('Tag name is required');
    err.status = 400;
    throw err;
  }

  const existing = await Tag.findOne({ where: { projectId, name: trimmed } });
  if (existing) {
    const err = new Error('A tag with this name already exists');
    err.status = 409;
    throw err;
  }

  return Tag.create({
    projectId,
    name: trimmed,
    color: color || '#3B82F6',
    createdBy: createdBy || null,
  });
}

async function updateTag({ tagId, projectId, name, color }) {
  const tag = await Tag.findOne({ where: { id: tagId, projectId } });
  if (!tag) {
    const err = new Error('Tag not found');
    err.status = 404;
    throw err;
  }

  const trimmed = name != null ? normalizeTagName(name) : tag.name;
  if (!trimmed) {
    const err = new Error('Tag name is required');
    err.status = 400;
    throw err;
  }

  if (trimmed !== tag.name) {
    const duplicate = await Tag.findOne({
      where: { projectId, name: trimmed, id: { [Op.ne]: tagId } },
    });
    if (duplicate) {
      const err = new Error('A tag with this name already exists');
      err.status = 409;
      throw err;
    }
  }

  await tag.update({
    name: trimmed,
    color: color != null ? color : tag.color,
  });
  return tag;
}

async function deleteTag({ tagId, projectId }) {
  const tag = await Tag.findOne({ where: { id: tagId, projectId } });
  if (!tag) {
    const err = new Error('Tag not found');
    err.status = 404;
    throw err;
  }

  const links = await ContactTag.findAll({
    where: { tagId },
    attributes: ['contactId'],
  });
  const contactIds = [...new Set(links.map((l) => l.contactId))];

  await ContactTag.destroy({ where: { tagId } });
  await tag.destroy();

  for (const contactId of contactIds) {
    await syncContactTagsJson(contactId);
  }

  return { deleted: true, contactIds };
}

async function assertContactInScope(contactId, userId, projectId, phone) {
  return resolveContactForTags({ contactId, phone, userId, projectId, createIfMissing: true });
}

async function assertTagInScope(tagId, projectId) {
  const tag = await Tag.findOne({ where: { id: tagId, projectId } });
  if (!tag) {
    const err = new Error('Tag not found');
    err.status = 404;
    throw err;
  }
  return tag;
}

async function syncContactTagsJson(contactId) {
  const rows = await Tag.findAll({
    include: [
      {
        model: ContactTag,
        as: 'contactTagLinks',
        where: { contactId },
        attributes: [],
        required: true,
      },
    ],
    order: [['name', 'ASC']],
  });
  const names = rows.map((t) => t.name);
  await Contact.update({ tags: names }, { where: { id: contactId } });
  return names;
}

async function getTagsForContact(contactId, projectId, phone, userId) {
  const contact = await resolveContactForTags({
    contactId,
    phone,
    userId,
    projectId,
    createIfMissing: false,
  });

  return Tag.findAll({
    where: projectId ? { projectId } : undefined,
    include: [
      {
        model: ContactTag,
        as: 'contactTagLinks',
        where: { contactId: contact.id },
        attributes: [],
        required: true,
      },
    ],
    order: [['name', 'ASC']],
  });
}

async function assignTagToContact({ contactId, tagId, userId, projectId, phone }) {
  const contact = await assertContactInScope(contactId, userId, projectId, phone);
  await assertTagInScope(tagId, projectId);
  contactId = contact.id;

  const [link, created] = await ContactTag.findOrCreate({
    where: { contactId, tagId },
    defaults: { contactId, tagId },
  });

  await syncContactTagsJson(contactId);
  return { link, created, contactId };
}

async function removeTagFromContact({ contactId, tagId, userId, projectId, phone }) {
  const contact = await assertContactInScope(contactId, userId, projectId, phone);
  await assertTagInScope(tagId, projectId);
  contactId = contact.id;

  const removed = await ContactTag.destroy({ where: { contactId, tagId } });
  await syncContactTagsJson(contactId);
  return { removed: removed > 0 };
}

async function assignTagByName({ contactId, projectId, userId, tagName, color }) {
  const name = normalizeTagName(tagName);
  if (!name) return null;

  await assertContactInScope(contactId, userId, projectId);

  let tag = await Tag.findOne({ where: { projectId, name } });
  if (!tag) {
    tag = await Tag.create({
      projectId,
      name,
      color: color || '#3B82F6',
      createdBy: userId || null,
    });
  }

  await ContactTag.findOrCreate({
    where: { contactId, tagId: tag.id },
    defaults: { contactId, tagId: tag.id },
  });

  await syncContactTagsJson(contactId);
  return tag;
}

async function getContactIdsByTagFilter({ projectId, tag, tagId, tagIds }) {
  const whereTag = { projectId };

  if (Array.isArray(tagIds) && tagIds.length > 0) {
    whereTag.id = { [Op.in]: tagIds.map((id) => Number(id)).filter((id) => id > 0) };
  } else if (tagId) {
    whereTag.id = Number(tagId);
  } else if (tag) {
    whereTag.name = normalizeTagName(tag);
  } else {
    return [];
  }

  const tags = await Tag.findAll({ where: whereTag, attributes: ['id'] });
  if (!tags.length) return [];

  const links = await ContactTag.findAll({
    where: { tagId: { [Op.in]: tags.map((t) => t.id) } },
    attributes: ['contactId'],
  });

  return [...new Set(links.map((l) => l.contactId))];
}

async function getContactsByTagIds({ projectId, userId, tagIds }) {
  const contactIds = await getContactIdsByTagFilter({ projectId, tagIds });
  if (!contactIds.length) return [];

  return Contact.findAll({
    where: {
      id: { [Op.in]: contactIds },
      userId,
      projectId,
    },
    attributes: ['id', 'phone', 'name', 'email', 'customFields', 'tags'],
  });
}

module.exports = {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  getTagsForContact,
  assignTagToContact,
  removeTagFromContact,
  assignTagByName,
  syncContactTagsJson,
  getContactIdsByTagFilter,
  getContactsByTagIds,
  resolveContactForTags,
};
