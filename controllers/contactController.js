const { Contact } = require('../models');
const { Op } = require('sequelize');
const tagService = require('../services/tagService');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const crypto = require('crypto');
const { requireProjectId, getProjectId } = require('../utils/projectScope');
const { normalizeWhatsAppRecipient } = require('../utils/phoneNormalize');
const { getCountryFromPhone } = require('../utils/phoneUtils');
const { enforcePlanLimit, checkPlanLimit, respondPlanLimitExceeded } = require('../services/planLimitService');

/** Digits-only phone strings that should match the same contact (e.g. 10-digit local vs 91…). */
const digitsOnlyPhoneVariants = (digits) => {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return [];
  const set = new Set([d]);
  const noLeadingZeros = d.replace(/^0+/, '') || d;
  if (noLeadingZeros !== d) set.add(noLeadingZeros);
  const core = noLeadingZeros;
  if (core.length === 10) {
    set.add(`91${core}`);
  }
  if (core.startsWith('91') && core.length === 12) {
    set.add(core.slice(2));
  }
  return [...set];
};

/** Find contact by phone variants for this user (account-wide, not project-scoped). */
const findContactByPhoneForUser = async (userId, phoneVariants) => {
  if (!phoneVariants?.length) return null;
  return Contact.findOne({
    where: { userId, phone: { [Op.in]: phoneVariants } },
    order: [['updatedAt', 'DESC']],
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => {
    cb(null, true);
  }
});

exports.createContact = async (req, res) => {
  let userId;
  let projectId;
  let normalizedPhone = '';
  const logCtx = () => ({
    userId,
    projectId,
    normalizedPhone,
    headerProjectId: req.headers['x-project-id'] || req.headers['x_project_id'] || null,
    reqProjectId: req.projectId ?? null,
    bodyProjectId: req.body?.projectId ?? null,
  });

  try {
    userId = req.user?.id;
    projectId = getProjectId(req) || requireProjectId(req, res);
    if (!projectId) {
      console.warn('[createContact] Missing project', logCtx());
      return;
    }

    console.log('[createContact] Request', {
      ...logCtx(),
      bodyKeys: Object.keys(req.body || {}),
      phoneRaw: req.body?.phone,
      name: req.body?.name,
    });

    const { phone, name, email, tags, country } = req.body;
    normalizedPhone =
      normalizeWhatsAppRecipient(phone) || String(phone || '').trim().replace(/\D/g, '');
    const emailValue =
      email && String(email).trim() ? String(email).trim() : null;

    if (!normalizedPhone || normalizedPhone.length < 10) {
      const message = 'Please enter a valid phone number (at least 10 digits)';
      console.warn('[createContact] Validation failed', { ...logCtx(), message });
      return res.status(400).json({
        success: false,
        message,
        code: 'INVALID_PHONE',
      });
    }

    const phoneVariants = digitsOnlyPhoneVariants(normalizedPhone);
    const existing = await findContactByPhoneForUser(userId, phoneVariants);

    if (existing) {
      const detectedCountry = getCountryFromPhone(normalizedPhone);
      await existing.update({
        projectId: null,
        name: name || existing.name || normalizedPhone,
        email: emailValue ?? existing.email,
        status: existing.status === 'unsubscribed' ? existing.status : 'active',
        whatsappOptInAt: existing.whatsappOptInAt || new Date(),
        country: existing.country || country || detectedCountry || null,
        country_code: existing.country_code || detectedCountry || country || null,
      });
      const contact = await existing.reload();
      console.log('[createContact] Updated existing contact (account-wide)', {
        ...logCtx(),
        contactId: contact.id,
      });
      return res.status(200).json({
        success: true,
        contact,
        message: 'Contact already exists — updated',
      });
    }

    const limitCheck = await enforcePlanLimit(req, res, 'contacts', { projectId });
    if (limitCheck && !limitCheck.allowed) return;

    const createPayload = {
      userId,
      projectId: null,
      phone: normalizedPhone,
      name: name || normalizedPhone,
      email: emailValue,
      tags: Array.isArray(tags) ? tags : tags || [],
      country: country || getCountryFromPhone(normalizedPhone) || null,
      country_code: getCountryFromPhone(normalizedPhone) || null,
      status: 'active',
      whatsappOptInAt: new Date(),
    };

    let contact;
    try {
      contact = await Contact.create(createPayload);
    } catch (createErr) {
      if (/whatsappOptInAt|Unknown column/i.test(String(createErr?.message || ''))) {
        console.warn('[createContact] Retrying without whatsappOptInAt column', logCtx());
        const { whatsappOptInAt, ...withoutOptIn } = createPayload;
        contact = await Contact.create(withoutOptIn);
      } else {
        throw createErr;
      }
    }

    console.log('[createContact] Created', { ...logCtx(), contactId: contact.id });
    return res.status(201).json({
      success: true,
      contact,
    });
  } catch (error) {
    const isDuplicate =
      error?.name === 'SequelizeUniqueConstraintError' ||
      error?.original?.code === 'ER_DUP_ENTRY' ||
      /duplicate entry/i.test(String(error?.message || ''));

    if (error?.name === 'SequelizeValidationError') {
      const message =
        error.errors?.map((e) => e.message).join(', ') || 'Validation failed';
      console.warn('[createContact] Validation error', { ...logCtx(), message });
      return res.status(400).json({
        success: false,
        message,
        code: 'VALIDATION_ERROR',
      });
    }

    if (isDuplicate) {
      const phoneVariants = digitsOnlyPhoneVariants(normalizedPhone);
      const existing = await findContactByPhoneForUser(userId, phoneVariants);
      if (existing) {
        console.warn('[createContact] Duplicate recovered', {
          ...logCtx(),
          contactId: existing.id,
        });
        return res.status(200).json({
          success: true,
          contact: existing,
          message: 'Contact already exists',
        });
      }
      const dupMessage = 'This phone number is already registered. Use a different number.';
      console.warn('[createContact] Duplicate unrecoverable', { ...logCtx(), sql: error?.parent?.sql });
      return res.status(400).json({
        success: false,
        message: dupMessage,
        code: 'DUPLICATE_PHONE',
      });
    }

    console.error('[createContact] Server error', {
      ...logCtx(),
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      sqlMessage: error?.parent?.sqlMessage,
    });
    return res.status(500).json({
      success: false,
      message: error?.message || 'Server error',
      code: 'SERVER_ERROR',
      error: error?.message,
    });
  }
};

exports.getContacts = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { status, type, search, tag, tagId, page = 1, limit = 20 } = req.query;

    const where = {
      userId,
      [Op.or]: [{ projectId }, { projectId: null }],
    };
    if (status) where.status = status;
    if (type === 'opted_in') where.whatsappOptInAt = { [Op.not]: null };
    if (type === 'not_opted_in') where.whatsappOptInAt = { [Op.is]: null };

    if (tag || tagId) {
      const contactIds = await tagService.getContactIdsByTagFilter({
        projectId,
        tag,
        tagId: tagId ? Number(tagId) : null,
      });
      if (!contactIds.length) {
        return res.json({
          success: true,
          contacts: [],
          pagination: {
            total: 0,
            page: parseInt(page),
            pages: 0,
            limit: parseInt(limit),
          },
        });
      }
      where.id = { [Op.in]: contactIds };
    }

    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } }
      ];
    }

    const offset = (page - 1) * limit;

    const { count, rows: contacts } = await Contact.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      contacts,
      pagination: {
        total: count,
        page: parseInt(page),
        pages: Math.ceil(count / limit),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.getContactById = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactId = req.params.id;

    const contact = await Contact.findOne({
      where: {
        id: contactId,
        userId,
        [Op.or]: [{ projectId }, { projectId: null }],
      },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    res.json({
      success: true,
      contact
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.importContacts = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactsData = req.body.contacts;

    if (!Array.isArray(contactsData) || contactsData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No contacts data provided'
      });
    }

    const limitCheck = await checkPlanLimit(projectId, 'contacts', { increment: contactsData.length });
    if (!limitCheck.allowed) {
      return respondPlanLimitExceeded(res, limitCheck);
    }

    const createdContacts = [];
    const errors = [];

    for (const contactData of contactsData) {
      try {
        const { phone, name, email, tags, country, customFields, ...rest } = contactData;
        const custom = customFields && typeof customFields === 'object' ? customFields : (Object.keys(rest).length ? rest : {});
        const normalizedPhone = String(phone || contactData.phone || '').trim().replace(/\D/g, '');
        if (!normalizedPhone || normalizedPhone.length < 10) {
          errors.push({
            phone: contactData.phone,
            error: 'Invalid phone number'
          });
          continue;
        }
        const phoneVariants = digitsOnlyPhoneVariants(normalizedPhone);
        const existing = phoneVariants.length
          ? await Contact.findOne({ where: { userId, phone: { [Op.in]: phoneVariants } } })
          : null;
        if (existing) {
          errors.push({
            phone: normalizedPhone,
            error: 'Contact with this phone number already exists',
          });
          continue;
        }

        const contact = await Contact.create({
          userId,
          projectId: null,
          phone: normalizedPhone,
          name: name || contactData.name || '',
          email: email || contactData.email || null,
          tags: tags || contactData.tags || [],
          country: country || getCountryFromPhone(normalizedPhone) || contactData.country || null,
          country_code: getCountryFromPhone(normalizedPhone) || country || contactData.country_code || null,
          customFields: custom
        });
        createdContacts.push(contact);
      } catch (error) {
        const isDuplicate =
          error?.name === 'SequelizeUniqueConstraintError' ||
          error?.original?.code === 'ER_DUP_ENTRY' ||
          /duplicate entry/i.test(String(error?.message || ''));
        if (isDuplicate) {
          errors.push({
            phone: contactData.phone,
            error: 'Contact with this phone number already exists for this account'
          });
          continue;
        }
        errors.push({
          phone: contactData.phone,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Successfully imported ${createdContacts.length} contacts`,
      importedCount: createdContacts.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

/** Stable unique phone/id when file has no digits — DB requires non-empty phone. */
function syntheticContactKey(userId, projectId, rowIndex) {
  const id = `${userId}_${projectId}_${rowIndex}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  return `import-${id}`.slice(0, 191);
}

function csvCellString(value) {
  if (value == null) return '';
  return String(value);
}

function looksLikePhoneValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function isPhoneHeader(key) {
  const lk = String(key || '').toLowerCase().trim();
  return (
    /^phone$/i.test(lk) ||
    /phone\s*number/i.test(lk) ||
    /^phonenumber$/i.test(lk) ||
    /^mobile$/i.test(lk) ||
    /^msisdn$/i.test(lk) ||
    /^whatsapp$/i.test(lk) ||
    /^tel$/i.test(lk) ||
    /^telephone$/i.test(lk) ||
    /^contact\s*number$/i.test(lk) ||
    /^cell\s*phone$/i.test(lk) ||
    /^number$/i.test(lk)
  );
}

function isNameHeader(key) {
  const lk = String(key || '').toLowerCase().trim();
  return (
    lk === 'name' ||
    /^full\s*name$/i.test(lk) ||
    /^contact\s*name$/i.test(lk) ||
    /^customer\s*name$/i.test(lk) ||
    /^first\s*name$/i.test(lk) ||
    /^last\s*name$/i.test(lk)
  );
}

function isEmailHeader(key) {
  const lk = String(key || '').toLowerCase().trim();
  return /^e-?mail$/i.test(lk) || /^email\s*address$/i.test(lk);
}

function isCountryHeader(key) {
  const lk = String(key || '').toLowerCase().trim();
  return /^country$/i.test(lk) || /^country\s*code$/i.test(lk);
}

function isTagsHeader(key) {
  const lk = String(key || '').toLowerCase().trim();
  return /^tags?$/i.test(lk) || /^labels?$/i.test(lk);
}

function parseTagsCell(value) {
  const raw = csvCellString(value).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {
      /* fall through */
    }
  }
  return raw
    .split(/[,|;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function csvRowToContactRecord(row, userId, projectId, rowIndex) {
  const keys = Object.keys(row || {});
  if (keys.length === 0) {
    return {
      phone: syntheticContactKey(userId, projectId, rowIndex),
      name: 'Imported',
      customFields: {},
    };
  }

  let phoneKey =
    keys.find((k) => /^phone$/i.test(String(k).trim())) ||
    keys.find((k) => /phone\s*number/i.test(String(k))) ||
    keys.find((k) => /phonenumber/i.test(String(k))) ||
    keys.find((k) => isPhoneHeader(k) && !isNameHeader(k));

  if (!phoneKey) {
    phoneKey = keys.find((k) => looksLikePhoneValue(row[k]));
  }

  let phoneRaw = phoneKey != null ? row[phoneKey] : '';
  if (csvCellString(phoneRaw).trim() === '') {
    for (const k of keys) {
      if (looksLikePhoneValue(row[k])) {
        phoneKey = k;
        phoneRaw = row[k];
        break;
      }
    }
  }

  const phoneTrimmed = csvCellString(phoneRaw).trim();
  let phone =
    normalizeWhatsAppRecipient(phoneTrimmed) ||
    phoneTrimmed.replace(/\D/g, '') ||
    '';
  if (!phone) {
    phone = syntheticContactKey(userId, projectId, rowIndex);
  }
  if (phone.length > 191) phone = phone.slice(0, 191);

  const firstNameKey = keys.find((k) => /^first\s*name$/i.test(String(k).trim()));
  const lastNameKey = keys.find((k) => /^last\s*name$/i.test(String(k).trim()));
  const nameKey =
    keys.find((k) => /^name$/i.test(String(k).trim())) ||
    keys.find((k) => /^full\s*name$/i.test(String(k))) ||
    keys.find((k) => /^contact\s*name$/i.test(String(k))) ||
    keys.find((k) => /^customer\s*name$/i.test(String(k)));

  let name = '';
  if (firstNameKey || lastNameKey) {
    name = [firstNameKey ? csvCellString(row[firstNameKey]).trim() : '', lastNameKey ? csvCellString(row[lastNameKey]).trim() : '']
      .filter(Boolean)
      .join(' ')
      .trim();
  } else if (nameKey) {
    name = csvCellString(row[nameKey]).trim();
  }
  if (!name) {
    for (const k of keys) {
      if (k === phoneKey || isPhoneHeader(k) || isEmailHeader(k) || isCountryHeader(k) || isTagsHeader(k)) {
        continue;
      }
      const v = csvCellString(row[k]).trim();
      if (v) {
        name = v;
        break;
      }
    }
  }
  if (!name) {
    name = phoneTrimmed || phone || 'Imported';
  }
  name = name.slice(0, 255);

  const emailKey = keys.find((k) => isEmailHeader(k));
  const emailRaw = emailKey ? csvCellString(row[emailKey]).trim() : '';
  const emailLooksValid =
    emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);
  const email = emailLooksValid ? emailRaw : null;

  const countryKey = keys.find((k) => isCountryHeader(k));
  const countryFromCsv = countryKey ? csvCellString(row[countryKey]).trim() : '';
  const countryCode = countryFromCsv || getCountryFromPhone(phone);

  const tagsKey = keys.find((k) => isTagsHeader(k));
  const tags = tagsKey ? parseTagsCell(row[tagsKey]) : null;

  const customFields = {};
  keys.forEach((key) => {
    const isPhoneCol = key === phoneKey || isPhoneHeader(key);
    const isNameCol =
      key === nameKey ||
      key === firstNameKey ||
      key === lastNameKey ||
      isNameHeader(key);
    const isEmailCol = isEmailHeader(key) && emailLooksValid;
    const isCountryCol = isCountryHeader(key);
    const isTagsCol = isTagsHeader(key);
    if (isPhoneCol || isNameCol || isEmailCol || isCountryCol || isTagsCol) {
      return;
    }
    customFields[key] = csvCellString(row[key]);
  });

  return {
    phone,
    name,
    email,
    tags,
    customFields,
    country_code: countryCode,
    country: countryCode,
  };
}

function linesToContactRecords(text, userId, projectId) {
  const lines = String(text || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const separator = detectCsvSeparator(lines[0]);
  const splitLine = (line) =>
    line.split(separator).map((p) => p.replace(/^"|"$/g, '').trim());

  const headerParts = splitLine(lines[0]);
  const hasHeader =
    headerParts.length > 1 &&
    headerParts.some((h) => isPhoneHeader(h) || isNameHeader(h) || isEmailHeader(h));

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const results = [];

  dataLines.forEach((line, i) => {
    const parts = splitLine(line).filter((p) => p.length > 0);
    if (parts.length === 0) return;

    if (hasHeader && headerParts.length === parts.length) {
      const row = {};
      headerParts.forEach((h, idx) => {
        row[h] = parts[idx];
      });
      results.push(csvRowToContactRecord(row, userId, projectId, i + 1));
      return;
    }

    const phoneIdx = parts.findIndex((p) => looksLikePhoneValue(p));
    const phoneRaw = phoneIdx >= 0 ? parts[phoneIdx] : parts[0];
    const phoneTrimmed = csvCellString(phoneRaw).trim();
    let phone =
      normalizeWhatsAppRecipient(phoneTrimmed) ||
      phoneTrimmed.replace(/\D/g, '') ||
      '';
    if (!phone) {
      phone = syntheticContactKey(userId, projectId, i + 1);
    }
    if (phone.length > 191) phone = phone.slice(0, 191);
    const namePart = parts.find((p, idx) => idx !== phoneIdx && csvCellString(p).trim());
    const name = (namePart || phoneTrimmed || 'Imported').slice(0, 255);
    const countryCode = getCountryFromPhone(phone);
    results.push({
      phone,
      name,
      email: null,
      tags: null,
      customFields: { raw: line.slice(0, 2000) },
      country_code: countryCode,
      country: countryCode,
    });
  });
  return results;
}

function bufferToUtf8Text(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  let nul = 0;
  const sample = Math.min(buf.length, 4096);
  for (let i = 0; i < sample; i += 1) {
    if (buf[i] === 0) nul += 1;
  }
  const ratio = nul / sample;
  let text;
  if (ratio > 0.06 && buf.length >= 2) {
    text =
      buf[0] === 0xff && buf[1] === 0xfe
        ? buf.slice(2).toString('utf16le')
        : buf.toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function detectCsvSeparator(firstLine) {
  const line = String(firstLine || '').trim();
  if (!line) return ',';
  let inQ = false;
  let commas = 0;
  let semis = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    if (inQ) continue;
    if (c === ',') commas += 1;
    if (c === ';') semis += 1;
  }
  return semis > commas ? ';' : ',';
}

function mergeCustomFields(existing, incoming) {
  const a = existing && typeof existing === 'object' ? existing : {};
  const b = incoming && typeof incoming === 'object' ? incoming : {};
  return { ...a, ...b };
}

/**
 * Create or update a contact row for import. Handles legacy DB unique indexes on (userId, phone)
 * without projectId by catching duplicate errors and updating the existing row.
 */
async function upsertContactImportRow(userId, projectId, row) {
  const uid = Number(userId);
  const phoneVariants = digitsOnlyPhoneVariants(row.phone);

  let contact = phoneVariants.length
    ? await Contact.findOne({
        where: { userId: uid, phone: { [Op.in]: phoneVariants } },
        order: [['updatedAt', 'DESC']],
      })
    : null;
  const importEmail =
    row.email !== undefined && row.email !== null && String(row.email).trim() !== ''
      ? String(row.email).trim()
      : null;
  const importTags = Array.isArray(row.tags) ? row.tags : null;

  if (contact) {
    await contact.update({
      projectId: null,
      name: row.name != null && String(row.name).trim() !== '' ? row.name : contact.name || 'Imported',
      email: importEmail !== null ? importEmail : contact.email,
      tags: importTags !== null ? importTags : contact.tags,
      customFields: mergeCustomFields(contact.customFields, row.customFields),
      country: row.country || row.country_code || contact.country || null,
      country_code: row.country_code || row.country || contact.country_code || null,
    });
    await contact.reload();
    return { contact, created: false };
  }

  try {
    contact = await Contact.create({
      userId: uid,
      projectId: null,
      phone: row.phone,
      name: row.name || 'Imported',
      email: importEmail,
      tags: importTags || [],
      customFields: row.customFields || {},
      country: row.country || row.country_code || null,
      country_code: row.country_code || row.country || null,
    });
    return { contact, created: true };
  } catch (e) {
    const dup =
      e?.name === 'SequelizeUniqueConstraintError' ||
      String(e?.parent?.code || '') === 'ER_DUP_ENTRY' ||
      /duplicate entry/i.test(String(e?.message || ''));
    if (!dup) throw e;

    contact = await Contact.findOne({
      where: { userId: uid, phone: { [Op.in]: phoneVariants.length ? phoneVariants : [row.phone] } },
      order: [['updatedAt', 'DESC']],
    });
    if (!contact) throw e;

    await contact.update({
      projectId: null,
      name: row.name != null && String(row.name).trim() !== '' ? row.name : contact.name || 'Imported',
      email: importEmail !== null ? importEmail : contact.email,
      tags: importTags !== null ? importTags : contact.tags,
      customFields: mergeCustomFields(contact.customFields, row.customFields),
      country: row.country || row.country_code || contact.country || null,
      country_code: row.country_code || row.country || contact.country_code || null,
    });
    await contact.reload();
    return { contact, created: false };
  }
}

// Upload CSV and save to contacts table (Step 2 of campaign flow)
exports.uploadCSV = upload.single('csvFile');
exports.parseAndSaveContactsCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
    }
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const text = bufferToUtf8Text(req.file.buffer);
    const firstLine = text.split('\n').find((l) => String(l).trim().length > 0) || '';
    const separator = detectCsvSeparator(firstLine);

    const results = [];
    let detectedHeaders = [];

    try {
      await new Promise((resolve, reject) => {
        let rowIndex = 0;
        const stream = Readable.from(text);
        stream
          .pipe(
            csv({
              separator,
              mapHeaders: ({ header }) => String(header || '').replace(/^\uFEFF/, '').trim(),
            })
          )
          .on('data', (row) => {
            rowIndex += 1;
            if (detectedHeaders.length === 0) detectedHeaders = Object.keys(row || {});
            results.push(csvRowToContactRecord(row, userId, projectId, rowIndex));
          })
          .on('end', resolve)
          .on('error', reject);
      });
    } catch (err) {
      console.warn('[parseAndSaveContactsCSV] csv stream error:', err?.message || err);
      results.length = 0;
      detectedHeaders = [];
    }

    let rows = results;
    if (rows.length === 0 && String(text || '').trim().length > 0) {
      rows = linesToContactRecords(text, userId, projectId);
    }

    if (rows.length > 0) {
      const limitCheck = await checkPlanLimit(projectId, 'contacts', { increment: rows.length });
      if (!limitCheck.allowed) {
        return respondPlanLimitExceeded(res, limitCheck);
      }
    }

    let created = 0;
    let updated = 0;
    const errors = [];
    const savedContacts = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      try {
        const { contact, created: isNew } = await upsertContactImportRow(userId, projectId, row);
        if (isNew) {
          created += 1;
        } else {
          updated += 1;
        }
        savedContacts.push(contact.get({ plain: true }));
      } catch (e) {
        errors.push({ phone: row.phone, error: e.message });
      }
    }

    const contactsOut = [...savedContacts].sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));

    return res.json({
      success: true,
      message:
        rows.length === 0
          ? 'No rows processed (empty file).'
          : `Contacts saved: ${created} created, ${updated} updated`,
      importedCount: created + updated,
      created,
      updated,
      rowCount: rows.length,
      columns: detectedHeaders.length ? detectedHeaders : undefined,
      errors: errors.length ? errors : undefined,
      contacts: contactsOut.slice(0, 200),
    });
  } catch (error) {
    console.error('Error parsing/saving contacts CSV:', error);
    return res.status(500).json({
      success: false,
      message: 'Error processing file',
      error: error.message,
    });
  }
};

exports.updateContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactId = req.params.id;
    const updates = req.body;

    const contact = await Contact.findOne({
      where: {
        id: contactId,
        userId,
        [Op.or]: [{ projectId }, { projectId: null }],
      },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    await contact.update(updates);

    res.json({
      success: true,
      contact
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.optOutContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactId = req.params.id;

    const contact = await Contact.findOne({
      where: {
        id: contactId,
        userId,
        [Op.or]: [{ projectId }, { projectId: null }],
      },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    // Update status to 'unsubscribed' (opt-out/block)
    await contact.update({
      status: 'unsubscribed',
      // Clear keyword opt-in timestamp so contact is treated as "not opted-in"
      whatsappOptInAt: null
    });

    res.json({
      success: true,
      message: 'Contact opted out successfully',
      contact
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.optInContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactId = req.params.id;

    const contact = await Contact.findOne({
      where: {
        id: contactId,
        userId,
        [Op.or]: [{ projectId }, { projectId: null }],
      },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    // Mark as opted-in (consent timestamp + active status)
    await contact.update({
      status: 'active',
      whatsappOptInAt: contact.whatsappOptInAt || new Date()
    });

    res.json({
      success: true,
      message: 'Contact opted in successfully',
      contact
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.deleteContact = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const contactId = req.params.id;

    const contact = await Contact.findOne({
      where: {
        id: contactId,
        userId,
        [Op.or]: [{ projectId }, { projectId: null }],
      },
    });

    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found'
      });
    }

    await contact.destroy();

    res.json({
      success: true,
      message: 'Contact deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};