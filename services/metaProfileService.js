const path = require('path');
const fs = require('fs');
const axios = require('axios');
const db = require('../config/db');
const { resolveWhatsAppSendCredentials } = require('../utils/metaWhatsAppCredentials');
const { uploadResumableMediaHandle } = require('./metaTemplateMediaService');
const { getProfileDirectApi } = require('./aisensyDirectApiClient');
function normalizeWebsite(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.slice(0, 256);
  return `https://${value}`.slice(0, 256);
}

function getMetaAppId() {
  return String(process.env.APP_ID || process.env.META_APP_ID || '').trim();
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function resolveLocalLogoAbsolutePath(logoPath) {
  if (!logoPath) return null;
  const value = String(logoPath).trim().replace(/\\/g, '/');
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  const cleaned = value.replace(/^\/+/, '');
  return path.join(__dirname, '..', cleaned);
}

/**
 * Resolve phone_number_id + access_token for this customer/project.
 * Prefers project-scoped whatsapp_accounts, then any account for the client.
 */
async function resolveWhatsAppAccountCreds(customerId, projectId) {
  const cid = Number(customerId);
  const pid = Number(projectId);

  if (Number.isInteger(cid) && cid > 0 && Number.isInteger(pid) && pid > 0) {
    const [scoped] = await db.query(
      `SELECT phone_number_id, access_token, waba_id
       FROM whatsapp_accounts
       WHERE client_id = ? AND projectId = ?
         AND phone_number_id IS NOT NULL AND TRIM(phone_number_id) != ''
         AND access_token IS NOT NULL AND TRIM(access_token) != ''
       ORDER BY id DESC
       LIMIT 1`,
      [cid, pid]
    );
    if (scoped?.[0]) {
      return {
        phoneNumberId: String(scoped[0].phone_number_id).trim(),
        accessToken: String(scoped[0].access_token).trim(),
        wabaId: String(scoped[0].waba_id || '').trim(),
        source: 'whatsapp_accounts_project',
      };
    }
  }

  if (Number.isInteger(cid) && cid > 0) {
    const [rows] = await db.query(
      `SELECT phone_number_id, access_token, waba_id
       FROM whatsapp_accounts
       WHERE client_id = ?
         AND phone_number_id IS NOT NULL AND TRIM(phone_number_id) != ''
         AND access_token IS NOT NULL AND TRIM(access_token) != ''
       ORDER BY id DESC
       LIMIT 1`,
      [cid]
    );
    if (rows?.[0]) {
      return {
        phoneNumberId: String(rows[0].phone_number_id).trim(),
        accessToken: String(rows[0].access_token).trim(),
        wabaId: String(rows[0].waba_id || '').trim(),
        source: 'whatsapp_accounts_client',
      };
    }
  }

  const fallback = await resolveWhatsAppSendCredentials(cid, pid);
  if (fallback?.phoneNumberId && fallback?.accessToken) {
    return {
      phoneNumberId: String(fallback.phoneNumberId).trim(),
      accessToken: String(fallback.accessToken).trim(),
      wabaId: String(fallback.wabaId || '').trim(),
      source: fallback.source || 'credential_resolver',
    };
  }

  return null;
}

/**
 * Upload local logo via Meta Resumable Upload API → profile_picture_handle.
 */
async function uploadMetaProfilePictureHandle(logoPath, accessToken, apiVersion) {
  const abs = resolveLocalLogoAbsolutePath(logoPath);
  if (!abs || !fs.existsSync(abs)) {
    return {
      ok: false,
      reason: 'logo_file_missing',
      message: `Logo file not found on disk: ${logoPath}`,
    };
  }

  const appId = getMetaAppId();
  if (!appId) {
    return {
      ok: false,
      reason: 'missing_app_id',
      message: 'META_APP_ID / APP_ID is not configured on the server',
    };
  }

  const buffer = fs.readFileSync(abs);
  if (!buffer.length) {
    return { ok: false, reason: 'empty_logo', message: 'Logo file is empty' };
  }

  const mimeType = mimeFromExt(abs);
  const fileName = path.basename(abs);

  try {
    const handle = await uploadResumableMediaHandle({
      buffer,
      mimeType,
      fileName,
      accessToken,
      appId,
      apiVersion,
    });
    return { ok: true, handle, path: abs, mimeType };
  } catch (err) {
    const message =
      err?.response?.data?.error?.message ||
      err?.message ||
      'Failed to upload logo to Meta Resumable Upload API';
    console.error('[metaProfileService] profile picture upload failed:', message);
    return { ok: false, reason: 'upload_failed', message };
  }
}

/**
 * Update WhatsApp Business Profile:
 * - description, address, email, websites
 * - profile picture via Resumable Upload → profile_picture_handle
 */
async function updateMetaProfile(
  customerId,
  description,
  address,
  email,
  website,
  logoPath,
  projectId = null
) {
  const creds = await resolveWhatsAppAccountCreds(customerId, projectId);
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    return {
      synced: false,
      skipped: true,
      reason: 'missing_whatsapp_credentials',
      message: 'No phone_number_id/access_token found for this account. Connect WhatsApp first.',
    };
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const payload = {
    messaging_product: 'whatsapp',
  };

  const desc = String(description || '').trim().slice(0, 512);
  const addr = String(address || '').trim().slice(0, 256);
  const mail = String(email || '').trim().slice(0, 128);
  const site = normalizeWebsite(website);

  if (desc) payload.description = desc;
  if (addr) payload.address = addr;
  if (mail) payload.email = mail;
  if (site) payload.websites = [site];

  let pictureUpload = null;
  if (logoPath) {
    pictureUpload = await uploadMetaProfilePictureHandle(
      logoPath,
      creds.accessToken,
      apiVersion
    );
    if (pictureUpload.ok && pictureUpload.handle) {
      payload.profile_picture_handle = pictureUpload.handle;
    }
  }

  const hasFields =
    Boolean(payload.description) ||
    Boolean(payload.address) ||
    Boolean(payload.email) ||
    Boolean(payload.websites) ||
    Boolean(payload.profile_picture_handle);

  if (!hasFields) {
    return {
      synced: false,
      skipped: true,
      reason: pictureUpload && !pictureUpload.ok ? pictureUpload.reason : 'no_meta_fields',
      message:
        pictureUpload && !pictureUpload.ok
          ? pictureUpload.message
          : 'No description/address/email/website/logo provided for Meta sync.',
      logoPath: logoPath || null,
      pictureUpload,
    };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}/whatsapp_business_profile`;

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      const metaMsg =
        res.data?.error?.message ||
        res.data?.error?.error_user_msg ||
        res.data?.message ||
        `Meta API error (${res.status})`;
      console.error('[metaProfileService] update failed:', metaMsg, res.data?.error || '');
      return {
        synced: false,
        skipped: false,
        reason: 'meta_api_error',
        message: metaMsg,
        status: res.status,
        credentialSource: creds.source,
        logoPath: logoPath || null,
        pictureUpload,
        profilePictureSynced: false,
      };
    }

    return {
      synced: true,
      skipped: false,
      credentialSource: creds.source,
      phoneNumberId: creds.phoneNumberId,
      logoPath: logoPath || null,
      pictureUpload,
      profilePictureSynced: Boolean(payload.profile_picture_handle),
      note:
        logoPath && !payload.profile_picture_handle
          ? `Logo saved locally but Meta photo upload failed: ${pictureUpload?.message || 'unknown'}`
          : undefined,
      meta: res.data,
    };
  } catch (err) {
    const metaMsg =
      err?.response?.data?.error?.message ||
      err?.message ||
      'Failed to update WhatsApp Business Profile';
    console.error('[metaProfileService] update exception:', metaMsg);
    return {
      synced: false,
      skipped: false,
      reason: 'meta_request_failed',
      message: metaMsg,
      logoPath: logoPath || null,
      pictureUpload,
      profilePictureSynced: false,
    };
  }
}

async function uploadMetaProfilePictureIfSupported(logoPath, creds) {
  if (!logoPath || !creds?.accessToken) return null;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  return uploadMetaProfilePictureHandle(logoPath, creds.accessToken, apiVersion);
}

const PROFILE_FIELDS =
  'about,address,description,email,profile_picture_url,websites,vertical';

function mapProfileRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    about: source.about || '',
    address: source.address || '',
    description: source.description || '',
    email: source.email || '',
    profile_picture_url: source.profile_picture_url || '',
    websites: Array.isArray(source.websites) ? source.websites : [],
    vertical: source.vertical || '',
    messaging_product: source.messaging_product || 'whatsapp',
    display_name: String(source.display_name || source.displayName || source.verified_name || '').trim(),
    verified_name: String(source.verified_name || source.verifiedName || source.display_name || '').trim(),
    name_status: String(source.name_status || source.nameStatus || '').trim(),
    display_phone_number: String(source.display_phone_number || source.displayPhoneNumber || '').trim(),
  };
}

function extractDisplayNameFromAisensyProfile(data) {
  if (!data || typeof data !== 'object') return '';
  const rows = Array.isArray(data.profileData) ? data.profileData : [];
  const first = rows[0] || data;
  return String(
    first.display_name ||
      first.displayName ||
      first.verified_name ||
      first.verifiedName ||
      data.display_name ||
      data.displayName ||
      ''
  ).trim();
}

/**
 * Meta Phone profile "Display name" (e.g. IDFC) lives on the phone number object as verified_name.
 */
async function fetchPhoneDisplayNameDetails(creds) {
  if (!creds?.phoneNumberId || !creds?.accessToken) return null;

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    params: { fields: 'display_phone_number,verified_name,name_status' },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    console.warn(
      '[metaProfileService] phone display name fetch failed:',
      res.data?.error?.message || res.status
    );
    return null;
  }

  const verifiedName = String(res.data?.verified_name || '').trim();
  return {
    display_name: verifiedName,
    verified_name: verifiedName,
    name_status: String(res.data?.name_status || '').trim(),
    display_phone_number: String(res.data?.display_phone_number || '').trim(),
  };
}

async function fetchMetaBusinessProfileRows(creds) {
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(creds.phoneNumberId)}/whatsapp_business_profile`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    params: { fields: PROFILE_FIELDS },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const err = new Error(
      res.data?.error?.message || res.data?.message || `Meta get profile failed (${res.status})`
    );
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.map((row) => mapProfileRow(row));
}

function mergeProfileWithPhoneDetails(profileRows, phoneDetails, aisensyDisplayName) {
  const phoneDisplayName =
    phoneDetails?.display_name || aisensyDisplayName || '';
  const rows = Array.isArray(profileRows) && profileRows.length ? profileRows : [mapProfileRow({})];

  return rows.map((row) =>
    mapProfileRow({
      ...row,
      display_name: phoneDetails?.display_name || row.display_name || aisensyDisplayName || '',
      verified_name: phoneDetails?.verified_name || row.verified_name || aisensyDisplayName || '',
      name_status: phoneDetails?.name_status || row.name_status || '',
      display_phone_number: phoneDetails?.display_phone_number || row.display_phone_number || '',
    })
  ).map((row) => ({
    ...row,
    display_name: row.display_name || phoneDisplayName,
    verified_name: row.verified_name || phoneDisplayName,
  }));
}
const DEFAULT_WABA_FIELDS = [
  'id',
  'account_review_status',
  'business_verification_status',
  'currency',
  'message_template_namespace',
  'name',
  'on_behalf_of_business_info',
  'ownership_type',
  'primary_funding_id',
  'timezone_id',
].join(',');

/**
 * Fetch WhatsApp Business Profile — AiSensy get-profile response shape.
 * Includes Meta Phone profile display name (verified_name), e.g. "IDFC".
 */
async function getMetaBusinessProfileDetails(customerId, projectId) {
  const creds = await resolveWhatsAppAccountCreds(customerId, projectId);
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    const err = new Error('WhatsApp phone_number_id / access_token not found for this project');
    err.statusCode = 400;
    throw err;
  }

  let profileRows = null;
  let aisensyDisplayName = '';
  let profileSource = 'meta_graph';

  try {
    const aisensyResult = await getProfileDirectApi({
      userId: customerId,
      localProjectId: projectId,
      projectId,
    });
    const aisensyData = aisensyResult?.data || {};
    aisensyDisplayName = extractDisplayNameFromAisensyProfile(aisensyData);
    if (Array.isArray(aisensyData.profileData) && aisensyData.profileData.length) {
      profileRows = aisensyData.profileData.map((row) => mapProfileRow(row));
      profileSource = 'aisensy_direct_api';
    }
  } catch (aisensyErr) {
    console.warn('[metaProfileService] AiSensy get-profile fallback to Meta Graph:', aisensyErr?.message);
  }

  if (!profileRows) {
    profileRows = await fetchMetaBusinessProfileRows(creds);
  }

  const phoneDetails = await fetchPhoneDisplayNameDetails(creds);
  const profileData = mergeProfileWithPhoneDetails(profileRows, phoneDetails, aisensyDisplayName);

  return {
    profileData,
    displayName: profileData[0]?.display_name || profileData[0]?.verified_name || '',
    credentialSource: creds.source,
    phoneNumberId: creds.phoneNumberId,
    profileSource,
  };
}
/**
 * Fetch WABA info — AiSensy get-business-info response shape.
 */
async function getMetaWabaInformation(customerId, projectId, fields) {
  const creds = await resolveWhatsAppAccountCreds(customerId, projectId);
  const wabaId =
    String(creds?.wabaId || '').trim() ||
    String(process.env.WABA_ID || process.env.WHATSAPP_WABA_ID || process.env.META_WABA_ID || '').trim();

  if (!wabaId || !creds?.accessToken) {
    const err = new Error('WhatsApp waba_id / access_token not found for this project');
    err.statusCode = 400;
    throw err;
  }

  const fieldList = String(fields || '').trim() || DEFAULT_WABA_FIELDS;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(wabaId)}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    params: { fields: fieldList },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const err = new Error(
      res.data?.error?.message || res.data?.message || `Meta get business info failed (${res.status})`
    );
    err.statusCode = res.status;
    err.response = { status: res.status, data: res.data };
    throw err;
  }

  return {
    data: res.data || {},
    credentialSource: creds.source,
    wabaId,
  };
}

module.exports = {
  updateMetaProfile,
  resolveWhatsAppAccountCreds,
  uploadMetaProfilePictureIfSupported,
  uploadMetaProfilePictureHandle,
  normalizeWebsite,
  getMetaBusinessProfileDetails,
  getMetaWabaInformation,
};
