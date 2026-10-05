const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveWhatsAppSendCredentialCandidates } = require('../utils/metaWhatsAppCredentials');

const MEDIA_DIR = path.join(__dirname, '../uploads/whatsapp-media');
const API_VERSION = process.env.META_API_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0';

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

function extFromMime(mimeType, fallback = 'bin') {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[String(mimeType || '').toLowerCase()] || fallback;
}

function localPathForMedia(mediaId, mimeType) {
  const safeId = String(mediaId || '').replace(/[^\w.-]/g, '_');
  const ext = extFromMime(mimeType);
  return path.join(MEDIA_DIR, `${safeId}.${ext}`);
}

function publicUrlForLocalPath(absPath) {
  const filename = path.basename(absPath);
  return `/uploads/whatsapp-media/${filename}`;
}

function findCachedMediaUrl(mediaId) {
  if (!mediaId) return null;
  ensureMediaDir();
  const safePrefix = String(mediaId).replace(/[^\w.-]/g, '_');
  const hit = fs.readdirSync(MEDIA_DIR).find((f) => f.startsWith(safePrefix + '.'));
  return hit ? `/uploads/whatsapp-media/${hit}` : null;
}

async function downloadWhatsAppMedia(mediaId, { userId, projectId } = {}) {
  if (!mediaId) return null;

  const cached = findCachedMediaUrl(mediaId);
  if (cached) return cached;

  const candidates = await resolveWhatsAppSendCredentialCandidates(userId, projectId);
  const withToken = (candidates || []).filter((c) => c?.accessToken);
  if (!withToken.length) {
    console.warn('downloadWhatsAppMedia: no Meta credentials for project', projectId);
    return null;
  }

  let mimeType = 'application/octet-stream';
  let fileBuffer = null;

  for (const creds of withToken) {
    const metaRes = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(mediaId)}`,
      {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        validateStatus: () => true,
        timeout: 20000,
      }
    );

    if (metaRes.status >= 400 || !metaRes.data?.url) {
      continue;
    }

    mimeType = metaRes.data.mime_type || mimeType;
    const fileRes = await axios.get(metaRes.data.url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 25 * 1024 * 1024,
      validateStatus: () => true,
    });

    if (fileRes.status < 400 && fileRes.data) {
      fileBuffer = Buffer.from(fileRes.data);
      break;
    }
  }

  if (!fileBuffer) {
    console.warn('downloadWhatsAppMedia failed for all credentials:', mediaId);
    return null;
  }

  ensureMediaDir();
  const localPath = localPathForMedia(mediaId, mimeType);
  fs.writeFileSync(localPath, fileBuffer);
  const publicUrl = publicUrlForLocalPath(localPath);
  console.log('✅ WhatsApp media cached:', mediaId, '→', publicUrl);
  return publicUrl;
}

function extractMediaIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const t = String(payload.type || '').toLowerCase();
  if (t === 'image') return payload.image?.id || null;
  if (t === 'video') return payload.video?.id || null;
  if (t === 'audio') return payload.audio?.id || null;
  if (t === 'document') return payload.document?.id || null;
  if (t === 'sticker') return payload.sticker?.id || null;
  return null;
}

function extractMimeFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const t = String(payload.type || '').toLowerCase();
  return payload[t]?.mime_type || null;
}

async function ensureMediaUrlForInboxRow(row, { userId, projectId } = {}) {
  const plain = row?.get ? row.get({ plain: true }) : { ...row };
  if (plain.mediaUrl && String(plain.mediaUrl).trim()) {
    return plain.mediaUrl;
  }

  let payload = null;
  try {
    payload = plain.payload ? JSON.parse(plain.payload) : null;
  } catch {
    payload = null;
  }

  const body = String(plain.message || '').trim();
  if (/^https?:\/\//i.test(body) || body.startsWith('/uploads/')) {
    return body.startsWith('/') ? body : body;
  }

  const mediaId = extractMediaIdFromPayload(payload);
  if (!mediaId) return null;

  return downloadWhatsAppMedia(mediaId, { userId, projectId });
}

module.exports = {
  downloadWhatsAppMedia,
  findCachedMediaUrl,
  ensureMediaUrlForInboxRow,
  extractMediaIdFromPayload,
  extractMimeFromPayload,
  publicUrlForLocalPath,
};
