const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');

const execFileAsync = promisify(execFile);
const WHATSAPP_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const { toPublicMediaUrl, toPermanentUploadPath } = require('../utils/templateMessageComponents');
const {
  getMetaTokenFromEnv,
  getMetaSystemUserToken,
  collectOutboundPhoneNumberIds,
} = require('../utils/metaWhatsAppCredentials');

function loadSharp() {
  try {
    return require('sharp');
  } catch (err) {
    console.warn('[header-media] sharp unavailable:', err?.message || err);
    return null;
  }
}

function resolveLocalMediaPath(publicUrl) {
  const value = String(publicUrl || '').trim();
  if (!value) return null;

  const tryRel = (rel) => {
    const safe = String(rel || '').replace(/^[/\\]+/, '').split('?')[0];
    if (!safe || safe.includes('..')) return null;
    const localPath = path.join(__dirname, '..', 'uploads', safe);
    if (fs.existsSync(localPath)) return localPath;
    return null;
  };

  const tryBasename = (name) => {
    const base = path.basename(String(name || '').split('?')[0]);
    if (!base || base.includes('..')) return null;
    return (
      tryRel(base) ||
      tryRel(path.join('videos', base)) ||
      tryRel(path.join('images', base)) ||
      tryRel(path.join('documents', base))
    );
  };

  if (value.startsWith('/uploads/')) {
    return tryRel(value.replace(/^\/uploads\/?/, '')) || tryBasename(value);
  }

  try {
    const parsed = new URL(value);
    const uploadPath = parsed.pathname || '';
    if (uploadPath.startsWith('/uploads/')) {
      return tryRel(uploadPath.replace(/^\/uploads\/?/, ''));
    }
    if (uploadPath.startsWith('/api/uploads/')) {
      return tryRel(uploadPath.replace(/^\/api\/uploads\/?/, ''));
    }
    if (uploadPath.startsWith('/api/media/public/')) {
      return tryRel(uploadPath.replace(/^\/api\/media\/public\/?/, ''));
    }
  } catch (_) {
    /* not a URL */
  }

  if (value.startsWith('/api/media/public/')) {
    return tryRel(value.replace(/^\/api\/media\/public\/?/, ''));
  }
  if (value.startsWith('/api/uploads/')) {
    return tryRel(value.replace(/^\/api\/uploads\/?/, ''));
  }

  // Bare filename e.g. flow-media-123.jpg
  if (!value.includes('/') && !value.includes('://')) {
    return tryRel(value) || tryBasename(value);
  }

  return tryBasename(value);
}

async function readMediaBuffer(publicUrl) {
  const candidates = buildHeaderMediaUrlCandidates(publicUrl);
  const seen = new Set();
  for (const raw of candidates) {
    const candidate = String(raw || '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    const localPath = resolveLocalMediaPath(candidate);
    if (localPath) {
      return {
        buffer: fs.readFileSync(localPath),
        filename: path.basename(localPath),
      };
    }
  }

  // /api/templates/:id/header-image → load from Template disk/base64
  const tplMatch = String(publicUrl || '').match(/\/api\/templates\/(\d+)\/header-image/i);
  if (tplMatch) {
    const { Template } = require('../models');
    const template = await Template.findByPk(Number(tplMatch[1]));
    const vars =
      template?.variables && typeof template.variables === 'object' ? template.variables : {};
    const permanent = toPermanentUploadPath(vars.headerMediaUrl || vars.header_media_url);
    if (permanent) {
      const localPath = resolveLocalMediaPath(permanent);
      if (localPath) {
        return {
          buffer: fs.readFileSync(localPath),
          filename: path.basename(localPath),
        };
      }
    }
    if (vars.headerMediaBase64) {
      return {
        buffer: Buffer.from(String(vars.headerMediaBase64), 'base64'),
        filename: 'header.jpg',
      };
    }
  }

  const fetchCandidates = [];
  const addFetch = (v) => {
    const raw = String(v || '').trim();
    if (!raw || fetchCandidates.includes(raw)) return;
    fetchCandidates.push(raw);
  };
  addFetch(toPublicMediaUrl(publicUrl));
  addFetch(toPublicMediaUrl(toPermanentUploadPath(publicUrl)));
  addFetch(publicUrl);

  for (const fetchUrl of fetchCandidates) {
    if (!fetchUrl || !/^https?:\/\//i.test(String(fetchUrl))) continue;
    const res = await axios.get(fetchUrl, {
      responseType: 'arraybuffer',
      timeout: 45000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (res.status >= 400) continue;
    const filename = String(fetchUrl).split('/').pop()?.split('?')[0] || 'header.jpg';
    return { buffer: Buffer.from(res.data), filename };
  }

  throw new Error('Header media file not found on disk and no public URL available');
}

function normalizeUploadFilename(filename, format = 'IMAGE') {
  const type = String(format || 'IMAGE').toUpperCase();
  const base = path.basename(String(filename || 'header.bin'));
  const ext = path.extname(base).toLowerCase();
  if (type === 'VIDEO') {
    if (['.mp4', '.3gp', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.wmv', '.flv', '.ogv'].includes(ext)) {
      return base;
    }
    return base.replace(/\.[^.]+$/, '') + '.mp4';
  }
  if (type === 'DOCUMENT') {
    if (ext === '.pdf') return base;
    return base.replace(/\.[^.]+$/, '') + '.pdf';
  }
  if (['.jpg', '.jpeg', '.png'].includes(ext)) return base;
  // WhatsApp template headers prefer JPEG/PNG — normalize odd extensions for upload.
  if (['.webp', '.gif', '.heic', '.heif', '.bmp', '.avif', '.tif', '.tiff'].includes(ext)) {
    return base.replace(/\.[^.]+$/, '') + '.jpg';
  }
  if (!ext) return `${base}.jpg`;
  return base;
}

function mimeTypeForHeader(filename, format = 'IMAGE') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.3gp') return 'video/3gpp';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
  if (ext === '.wmv') return 'video/x-ms-wmv';
  if (ext === '.flv') return 'video/x-flv';
  if (ext === '.ogv') return 'video/ogg';
  if (ext === '.pdf') return 'application/pdf';
  if (format === 'VIDEO') return 'video/mp4';
  if (format === 'DOCUMENT') return 'application/pdf';
  return 'image/jpeg';
}

async function transcodeVideoToWhatsAppMp4(buffer, filename) {
  if (!buffer?.length) return null;
  if (buffer.length > WHATSAPP_VIDEO_MAX_BYTES) {
    console.warn('[header-media] video exceeds 50 MB limit; will attempt transcode/compress');
  }

  const ffmpegPath = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-carousel-vid-'));
  const inName = path.basename(String(filename || 'video.bin')) || 'video.bin';
  const inPath = path.join(tmpDir, inName);
  const outPath = path.join(tmpDir, 'whatsapp.mp4');

  try {
    fs.writeFileSync(inPath, buffer);
    await execFileAsync(
      ffmpegPath,
      [
        '-y',
        '-i',
        inPath,
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-level',
        '3.1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-fs',
        String(WHATSAPP_VIDEO_MAX_BYTES),
        outPath,
      ],
      { timeout: 180000, maxBuffer: 64 * 1024 * 1024 }
    );
    if (!fs.existsSync(outPath)) return null;
    const out = fs.readFileSync(outPath);
    if (!out?.length) return null;
    const base = path.basename(inName, path.extname(inName)) || 'carousel';
    return { buffer: out, filename: `${base}.mp4` };
  } catch (err) {
    console.warn('[header-media] ffmpeg transcode failed:', err?.message || err);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

async function normalizeHeaderBufferForWhatsApp(buffer, filename, headerFormat = 'IMAGE') {
  const format = String(headerFormat || 'IMAGE').toUpperCase();
  if (!buffer?.length) {
    return { buffer, filename: normalizeUploadFilename(filename, format) };
  }

  if (format === 'VIDEO') {
    const ext = path.extname(String(filename || '')).toLowerCase();
    const isLikelyWhatsAppMp4 = ext === '.mp4' && buffer.length <= WHATSAPP_VIDEO_MAX_BYTES;
    if (!isLikelyWhatsAppMp4) {
      const transcoded = await transcodeVideoToWhatsAppMp4(buffer, filename);
      if (transcoded?.buffer?.length) {
        return transcoded;
      }
    }
    return { buffer, filename: normalizeUploadFilename(filename, format) };
  }

  if (format !== 'IMAGE') {
    return { buffer, filename: normalizeUploadFilename(filename, format) };
  }

  const ext = path.extname(String(filename || '')).toLowerCase();
  const needsConvert = ['.webp', '.gif', '.heic', '.heif', '.bmp', '.avif', '.tif', '.tiff'].includes(ext);
  if (!needsConvert && ['.jpg', '.jpeg', '.png'].includes(ext)) {
    return { buffer, filename: path.basename(String(filename || 'header.jpg')) };
  }

  try {
    const sharp = loadSharp();
    if (!sharp) {
      return { buffer, filename: normalizeUploadFilename(filename, format) };
    }
    const converted = await sharp(buffer)
      .rotate()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    const base = path.basename(String(filename || 'header'), ext).replace(/\.[^.]+$/, '') || 'header';
    return { buffer: converted, filename: `${base}.jpg` };
  } catch (err) {
    console.warn('[header-media] sharp convert failed, using original buffer:', err?.message || err);
    return { buffer, filename: normalizeUploadFilename(filename, format) };
  }
}

function formatMetaMediaUploadError(res) {
  const err = res?.data?.error;
  if (!err) {
    return res?.status ? `WhatsApp media upload HTTP ${res.status}` : 'WhatsApp media upload failed';
  }
  const code = err.code != null ? `#${err.code}` : '';
  const parts = [
    [err.message, code].filter(Boolean).join(' '),
    err.error_user_msg,
    err.error_data?.details,
  ].filter(Boolean);
  return parts.join(' — ') || 'WhatsApp media upload failed';
}

function collectUploadTokens(creds) {
  const tokens = [];
  const seen = new Set();
  const add = (token) => {
    const value = String(token || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    tokens.push(value);
  };
  add(creds?.accessToken);
  add(getMetaSystemUserToken());
  add(getMetaTokenFromEnv());
  return tokens;
}

async function uploadMediaBufferToWhatsApp(creds, buffer, filename, headerFormat = 'IMAGE', phoneNumberIdOverride = null) {
  const phoneNumberId = String(phoneNumberIdOverride || creds?.phoneNumberId || '').trim();
  if (!phoneNumberId || !buffer?.length) {
    return {
      mediaId: null,
      phoneNumberId: phoneNumberId || null,
      lastError: !phoneNumberId ? 'Missing WhatsApp phone_number_id for media upload' : 'Empty media buffer',
    };
  }

  const format = String(headerFormat || 'IMAGE').toUpperCase();
  const typeKey =
    format === 'VIDEO' ? 'video' : format === 'DOCUMENT' ? 'document' : 'image';

  const normalized = await normalizeHeaderBufferForWhatsApp(buffer, filename, format);
  const uploadFilename = normalizeUploadFilename(normalized.filename, format);
  const uploadMime = mimeTypeForHeader(uploadFilename, format);
  const apiVersion = creds?.apiVersion || process.env.WHATSAPP_API_VERSION || 'v22.0';
  const uploadUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/media`;
  const tokens = collectUploadTokens(creds);
  let lastError = null;

  for (const token of tokens) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', typeKey);
    form.append('file', normalized.buffer, {
      filename: uploadFilename,
      contentType: uploadMime,
    });

    const res = await axios.post(uploadUrl, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      timeout: format === 'VIDEO' ? 180000 : 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (res.status < 400 && res.data?.id) {
      return { mediaId: String(res.data.id), phoneNumberId, lastError: null };
    }

    lastError = formatMetaMediaUploadError(res);
    console.warn(
      'WhatsApp media buffer upload failed:',
      phoneNumberId,
      res.status,
      lastError
    );
  }

  return { mediaId: null, phoneNumberId, lastError };
}

/**
 * Upload header file to WhatsApp Cloud API so template sends use media id (more reliable than link).
 */
async function uploadTemplateHeaderMediaId(creds, headerMediaUrl, headerFormat = 'IMAGE', phoneNumberIdOverride = null) {
  const phoneNumberId = String(phoneNumberIdOverride || creds?.phoneNumberId || '').trim();
  if (!headerMediaUrl) {
    return { mediaId: null, phoneNumberId: phoneNumberId || null, lastError: 'Missing header media URL' };
  }
  if (!phoneNumberId) {
    return { mediaId: null, phoneNumberId: null, lastError: 'Missing WhatsApp phone_number_id for media upload' };
  }

  try {
    const { buffer, filename } = await readMediaBuffer(headerMediaUrl);
    if (!buffer?.length) {
      return { mediaId: null, phoneNumberId, lastError: 'Media file is empty or could not be read' };
    }
    return await uploadMediaBufferToWhatsApp(creds, buffer, filename, headerFormat, phoneNumberId);
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn('uploadTemplateHeaderMediaId:', msg);
    return { mediaId: null, phoneNumberId, lastError: msg };
  }
}

function buildHeaderMediaUrlCandidates(headerMediaUrl) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    candidates.push(raw);
  };

  add(headerMediaUrl);
  add(toPermanentUploadPath(headerMediaUrl));
  add(toPublicMediaUrl(headerMediaUrl));
  add(toPublicMediaUrl(toPermanentUploadPath(headerMediaUrl)));

  return candidates;
}

/**
 * Try every credential, phone_number_id, and URL variant until WhatsApp accepts the upload.
 * Returns { mediaId, phoneNumberId } — phoneNumberId must be used when sending the template.
 */
async function resolveHeaderMediaIdForSend(
  credentialCandidates,
  headerMediaUrl,
  headerFormat = 'IMAGE',
  options = {}
) {
  const credsList = (credentialCandidates || []).filter((c) => c?.accessToken);
  if (!credsList.length || !headerMediaUrl) {
    return { mediaId: null, phoneNumberId: null, lastError: 'Missing WhatsApp credentials or media URL' };
  }

  const urlCandidates = buildHeaderMediaUrlCandidates(headerMediaUrl);
  const phoneNumberIds = collectOutboundPhoneNumberIds(credsList, options);
  let lastError = null;

  for (const phoneNumberId of phoneNumberIds) {
    const credsForPhone = credsList.filter(
      (c) => String(c?.phoneNumberId || '').trim() === String(phoneNumberId).trim()
    );
    const credsOrder = credsForPhone.length ? credsForPhone : credsList;

    for (const creds of credsOrder) {
      for (const candidate of urlCandidates) {
        const uploaded = await uploadTemplateHeaderMediaId(
          creds,
          candidate,
          headerFormat,
          phoneNumberId
        );
        if (uploaded?.mediaId) {
          return {
            mediaId: uploaded.mediaId,
            phoneNumberId: uploaded.phoneNumberId || phoneNumberId,
            lastError: null,
          };
        }
        if (uploaded?.lastError) lastError = uploaded.lastError;
      }

      for (const candidate of urlCandidates) {
        try {
          const { buffer, filename } = await readMediaBuffer(candidate);
          const uploaded = await uploadMediaBufferToWhatsApp(
            creds,
            buffer,
            filename,
            headerFormat,
            phoneNumberId
          );
          if (uploaded?.mediaId) {
            return {
              mediaId: uploaded.mediaId,
              phoneNumberId: uploaded.phoneNumberId || phoneNumberId,
              lastError: null,
            };
          }
          if (uploaded?.lastError) lastError = uploaded.lastError;
        } catch (readErr) {
          lastError = readErr?.message || String(readErr);
          console.warn('[campaign-header-media] read failed for', candidate, lastError);
        }
      }
    }
  }

  return { mediaId: null, phoneNumberId: null, lastError };
}

module.exports = {
  uploadTemplateHeaderMediaId,
  uploadMediaBufferToWhatsApp,
  resolveHeaderMediaIdForSend,
  resolveLocalMediaPath,
  readMediaBuffer,
  buildHeaderMediaUrlCandidates,
};
