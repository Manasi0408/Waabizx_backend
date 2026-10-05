const db = require('../config/db');
const { updateMetaProfile } = require('../services/metaProfileService');

async function ensureBusinessProfileTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS business_profile (
      id INT PRIMARY KEY AUTO_INCREMENT,
      customer_id INT NOT NULL,
      project_id INT NULL,
      name VARCHAR(255) NULL,
      category VARCHAR(64) NULL,
      country_code VARCHAR(16) NULL,
      phone VARCHAR(32) NULL,
      description TEXT NULL,
      address TEXT NULL,
      email VARCHAR(255) NULL,
      website VARCHAR(255) NULL,
      logo VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_customer_project (customer_id, project_id)
    )
  `);
}

function resolveProjectId(req) {
  const fromHeader = req.headers['x-project-id'];
  const fromBody = req.body?.projectId ?? req.body?.project_id;
  const fromQuery = req.query?.projectId ?? req.query?.project_id;
  const raw = fromBody ?? fromHeader ?? fromQuery;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

exports.getBusinessProfile = async (req, res) => {
  try {
    await ensureBusinessProfileTable();
    const customerId = req.user.id;
    const projectId = resolveProjectId(req);

    let rows;
    if (projectId) {
      [rows] = await db.query(
        `SELECT * FROM business_profile
         WHERE customer_id = ? AND project_id = ?
         LIMIT 1`,
        [customerId, projectId]
      );
    } else {
      [rows] = await db.query(
        `SELECT * FROM business_profile
         WHERE customer_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [customerId]
      );
    }

    const profile = rows?.[0] || null;
    return res.json({
      success: true,
      profile: profile
        ? {
            id: profile.id,
            customer_id: profile.customer_id,
            project_id: profile.project_id,
            name: profile.name || '',
            category: profile.category || '',
            countryCode: profile.country_code || '+91',
            phone: profile.phone || '',
            description: profile.description || '',
            address: profile.address || '',
            email: profile.email || '',
            website: profile.website || '',
            logo: profile.logo || null,
          }
        : null,
    });
  } catch (err) {
    console.error('getBusinessProfile:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to load profile' });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    await ensureBusinessProfileTable();

    const customerId = req.user.id;
    const projectId = resolveProjectId(req);

    const name = req.body?.name != null ? String(req.body.name).trim() : '';
    const category = req.body?.category != null
      ? String(req.body.category).trim().toUpperCase().slice(0, 32)
      : '';
    const countryCode = req.body?.countryCode != null
      ? String(req.body.countryCode).trim()
      : (req.body?.country_code != null ? String(req.body.country_code).trim() : '+91');
    const phone = req.body?.phone != null
      ? String(req.body.phone).replace(/\D/g, '')
      : '';
    const description = req.body?.description != null ? String(req.body.description).trim() : '';
    const address = req.body?.address != null ? String(req.body.address).trim() : '';
    const email = req.body?.email != null ? String(req.body.email).trim() : '';
    const website = req.body?.website != null ? String(req.body.website).trim() : '';
    const removeLogo = String(req.body?.removeLogo || '').trim() === '1';

    if (!name) {
      return res.status(400).json({ success: false, message: 'Business name is required' });
    }

    const logoPath = req.file ? `uploads/${req.file.filename}` : null;

    let existing = null;
    if (projectId) {
      const [rows] = await db.query(
        `SELECT * FROM business_profile WHERE customer_id = ? AND project_id = ? LIMIT 1`,
        [customerId, projectId]
      );
      existing = rows?.[0] || null;
    } else {
      const [rows] = await db.query(
        `SELECT * FROM business_profile WHERE customer_id = ? AND project_id IS NULL LIMIT 1`,
        [customerId]
      );
      existing = rows?.[0] || null;
    }

    let nextLogo = existing?.logo || null;
    if (logoPath) nextLogo = logoPath;
    if (removeLogo && !logoPath) nextLogo = null;

    if (existing) {
      await db.query(
        `UPDATE business_profile
         SET name = ?, category = ?, country_code = ?, phone = ?,
             description = ?, address = ?, email = ?, website = ?, logo = ?
         WHERE id = ? AND customer_id = ?`,
        [
          name,
          category || 'BUSINESS',
          countryCode || '+91',
          phone,
          description,
          address,
          email,
          website,
          nextLogo,
          existing.id,
          customerId,
        ]
      );
    } else {
      await db.query(
        `INSERT INTO business_profile
          (customer_id, project_id, name, category, country_code, phone, description, address, email, website, logo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          projectId,
          name,
          category || 'BUSINESS',
          countryCode || '+91',
          phone,
          description,
          address,
          email,
          website,
          nextLogo,
        ]
      );
    }

    // Sync supported fields + profile picture (Resumable Upload → profile_picture_handle) to Meta.
    const metaSync = await updateMetaProfile(
      customerId,
      description,
      address,
      email,
      website,
      nextLogo,
      projectId
    );

    return res.json({
      success: true,
      logo: nextLogo,
      metaSync,
      profile: {
        name,
        category: category || 'BUSINESS',
        countryCode: countryCode || '+91',
        phone,
        description,
        address,
        email,
        website,
        logo: nextLogo,
        project_id: projectId,
      },
    });
  } catch (err) {
    console.error('updateProfile:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to update profile' });
  }
};
