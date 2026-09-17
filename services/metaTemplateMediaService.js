const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Minimal valid MP4 placeholder for Meta template header_handle (real media attached at send time). */
const DEFAULT_SAMPLE_MP4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAABltZWxhAQAAACB0b2tlbgEAAAAUdGFsAAAAIAAAAAxhdmMxAAAAD3NvdXJjZQAAABJ1c2VyX2xpYnJhcnk=',
  'base64'
);

/** Minimal valid PDF placeholder for Meta template header_handle (real media attached at send time). */
const DEFAULT_SAMPLE_PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5vb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKL01lZGlhQm94IFswIDAgMyAzXQo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9DcmVhdG9yIChNb2R1bGVhcykKPj4KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNyAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDE3OCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDUKL1Jvb3QgMSAwIFIKPj4Kc3RhcnR4cmVmCjI0NwolJUVPRg==',
  'base64'
);

const FORMAT_DEFAULTS = {
  IMAGE: {
    buffer: DEFAULT_SAMPLE_PNG,
    mimeType: 'image/png',
    fileName: 'template_header_sample.png',
  },
  VIDEO: {
    buffer: DEFAULT_SAMPLE_MP4,
    mimeType: 'video/mp4',
    fileName: 'template_header_sample.mp4',
  },
  DOCUMENT: {
    buffer: DEFAULT_SAMPLE_PDF,
    mimeType: 'application/pdf',
    fileName: 'template_header_sample.pdf',
  },
};

/** Shared across all tenants — survives restarts and PM2 workers (same disk). */
const PERSISTENT_HANDLES_FILE = path.join(__dirname, '../data/meta-template-header-handles.json');

/** One upload in flight per cache key (default format or content hash). */
const uploadInflight = new Map();

function getMetaAppId() {
  return String(process.env.APP_ID || process.env.META_APP_ID || '').trim();
}

function getMetaApiVersion() {
  return process.env.WHATSAPP_API_VERSION || 'v22.0';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMetaRateLimitError(err) {
  const code = err?.response?.data?.error?.code;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  return code === 4 || /application request limit reached/i.test(msg);
}

async function withMetaRateLimitRetry(run) {
  const backoffMs = [3000, 10000, 25000];
  let lastErr;
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      if (!isMetaRateLimitError(err) || attempt >= backoffMs.length) {
        throw err;
      }
      await sleep(backoffMs[attempt]);
    }
  }
  throw lastErr;
}

function readPersistentHandleStore() {
  try {
    if (!fs.existsSync(PERSISTENT_HANDLES_FILE)) return {};
    const raw = fs.readFileSync(PERSISTENT_HANDLES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePersistentHandleStore(store) {
  try {
    fs.mkdirSync(path.dirname(PERSISTENT_HANDLES_FILE), { recursive: true });
    fs.writeFileSync(PERSISTENT_HANDLES_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not persist Meta template header handles:', err.message);
  }
}

function envHandleForFormat(format) {
  const key = String(format || '').toUpperCase();
  const map = {
    IMAGE: process.env.META_TEMPLATE_SAMPLE_IMAGE_HANDLE || process.env.META_DEFAULT_IMAGE_HEADER_HANDLE,
    VIDEO: process.env.META_TEMPLATE_SAMPLE_VIDEO_HANDLE || process.env.META_DEFAULT_VIDEO_HEADER_HANDLE,
    DOCUMENT:
      process.env.META_TEMPLATE_SAMPLE_DOCUMENT_HANDLE || process.env.META_DEFAULT_DOCUMENT_HEADER_HANDLE,
  };
  const value = map[key];
  return value ? String(value).trim() : '';
}

function contentCacheKey(format, buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  return `${String(format || '').toUpperCase()}:${hash}`;
}

function getPersistedHandle(cacheKey) {
  const appId = getMetaAppId() || 'default';
  const store = readPersistentHandleStore();
  const entry = store?.[appId]?.[cacheKey];
  const handle = entry?.handle ? String(entry.handle).trim() : '';
  return handle || null;
}

function persistHandle(cacheKey, handle) {
  const appId = getMetaAppId() || 'default';
  if (!cacheKey || !handle) return;
  const store = readPersistentHandleStore();
  if (!store[appId]) store[appId] = {};
  store[appId][cacheKey] = {
    handle: String(handle).trim(),
    savedAt: new Date().toISOString(),
  };
  writePersistentHandleStore(store);
}

function resolveCachedHandle(format, buffer, usingDefaultSample) {
  const fromEnv = envHandleForFormat(format);
  if (fromEnv) return fromEnv;

  const cacheKey = usingDefaultSample
    ? `default:${String(format || '').toUpperCase()}`
    : contentCacheKey(format, buffer);

  const persisted = getPersistedHandle(cacheKey);
  if (persisted) return persisted;

  return { cacheKey, handle: null };
}

async function obtainHeaderHandleWithSingleFlight(cacheKey, uploadFn) {
  const cached = getPersistedHandle(cacheKey);
  if (cached) return cached;

  if (uploadInflight.has(cacheKey)) {
    return uploadInflight.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const handle = await uploadFn();
      if (handle) persistHandle(cacheKey, handle);
      return handle;
    } catch (err) {
      if (isMetaRateLimitError(err)) {
        const stale = getPersistedHandle(cacheKey);
        if (stale) return stale;
      }
      throw err;
    } finally {
      uploadInflight.delete(cacheKey);
    }
  })();

  uploadInflight.set(cacheKey, promise);
  return promise;
}

async function uploadResumableMediaHandle({ buffer, mimeType, fileName, accessToken, appId, apiVersion }) {
  if (!appId) {
    throw new Error('META_APP_ID is not configured on the server');
  }
  if (!accessToken) {
    throw new Error('WhatsApp access token is not available');
  }
  if (!buffer || !buffer.length) {
    throw new Error('Header media file is empty');
  }

  const sessionRes = await axios.post(
    `https://graph.facebook.com/${apiVersion}/${appId}/uploads`,
    null,
    {
      params: {
        file_name: fileName || 'template_header_sample.png',
        file_length: buffer.length,
        file_type: mimeType || 'image/png',
        access_token: accessToken,
      },
    }
  );

  const uploadSessionId = sessionRes.data?.id;
  if (!uploadSessionId) {
    throw new Error('Meta upload session did not return an id');
  }

  const uploadRes = await axios.post(
    `https://graph.facebook.com/${apiVersion}/${uploadSessionId}`,
    buffer,
    {
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_offset: 0,
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  const handle = uploadRes.data?.h;
  if (!handle) {
    throw new Error('Meta upload did not return a media handle');
  }

  return handle;
}

async function resolveHeaderMediaBuffer(headerMedia, format) {
  if (headerMedia?.data) {
    const buffer = Buffer.from(String(headerMedia.data), 'base64');
    if (!buffer.length) {
      throw new Error('Header media file is empty');
    }
    return {
      buffer,
      mimeType: headerMedia.mimeType || FORMAT_DEFAULTS[format]?.mimeType || FORMAT_DEFAULTS.IMAGE.mimeType,
      fileName: headerMedia.fileName || FORMAT_DEFAULTS[format]?.fileName || 'template_header_sample.bin',
    };
  }

  const defaults = FORMAT_DEFAULTS[format];
  if (!defaults) {
    throw new Error(`Please upload a sample ${format.toLowerCase()} for the template header`);
  }

  return defaults;
}

async function attachHeaderMediaExample(headerComponent, { accessToken, headerMedia }) {
  const format = String(headerComponent?.format || '').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    return headerComponent;
  }

  const existing = headerComponent?.example?.header_handle;
  if (Array.isArray(existing) && existing.length > 0 && String(existing[0] || '').trim()) {
    return headerComponent;
  }

  const usingDefaultSample = !headerMedia?.data;
  const { buffer, mimeType, fileName } = await resolveHeaderMediaBuffer(headerMedia, format);

  const cacheLookup = resolveCachedHandle(format, buffer, usingDefaultSample);
  if (typeof cacheLookup === 'string') {
    return {
      ...headerComponent,
      example: { header_handle: [cacheLookup] },
    };
  }

  const { cacheKey } = cacheLookup;
  const appId = getMetaAppId();
  const apiVersion = getMetaApiVersion();

  const handle = await obtainHeaderHandleWithSingleFlight(cacheKey, () =>
    uploadResumableMediaHandle({
      buffer,
      mimeType,
      fileName,
      accessToken,
      appId,
      apiVersion,
    })
  );

  return {
    ...headerComponent,
    example: {
      header_handle: [handle],
    },
  };
}

function formatAxiosMetaError(err) {
  const metaMsg = err?.response?.data?.error?.message;
  const code = err?.response?.data?.error?.code;
  if (code === 4 || /application request limit reached/i.test(String(metaMsg || ''))) {
    return (
      'Meta app rate limit (#4): sample header media is cached on the server — wait 1–2 minutes and try once. ' +
      'To avoid uploads entirely, set META_TEMPLATE_SAMPLE_IMAGE_HANDLE (and VIDEO if needed) in server env.'
    );
  }
  if (metaMsg) return metaMsg;
  if (err?.response?.status === 403) {
    return 'Meta rejected the media upload (403). Ensure META_APP_ID / APP_ID matches your Meta app and the token can manage WhatsApp assets.';
  }
  return err?.message || 'Media upload failed';
}

async function attachHeaderMediaExampleCached(headerComponent, options, handleCache) {
  const format = String(headerComponent?.format || '').toUpperCase();
  const cached = handleCache.get(format);
  if (cached) {
    return {
      ...headerComponent,
      example: { header_handle: [cached] },
    };
  }
  const enriched = await attachHeaderMediaExample(headerComponent, options);
  const handle = enriched?.example?.header_handle?.[0];
  if (handle) handleCache.set(format, handle);
  return enriched;
}

async function enrichCardComponentsWithHeaderExamples(cardComponents, options, handleCache) {
  if (!Array.isArray(cardComponents)) return cardComponents;
  const out = [];
  for (const sub of cardComponents) {
    const subType = String(sub?.type || '').trim().toUpperCase();
    if (subType !== 'HEADER') {
      out.push(sub);
      continue;
    }
    out.push(await attachHeaderMediaExampleCached(sub, options, handleCache));
  }
  return out;
}

async function enrichComponentsWithHeaderExamples(components, { accessToken, headerMedia }) {
  if (!Array.isArray(components)) return components;

  const options = { accessToken, headerMedia };
  const handleCache = new Map();

  const result = [];
  for (const component of components) {
    const type = String(component?.type || '').trim().toUpperCase();
    if (type === 'HEADER') {
      result.push(await attachHeaderMediaExampleCached(component, options, handleCache));
      continue;
    }
    if (type === 'CAROUSEL' && Array.isArray(component.cards)) {
      const cards = [];
      for (const card of component.cards) {
        const enriched = await enrichCardComponentsWithHeaderExamples(
          card?.components,
          options,
          handleCache
        );
        cards.push({ ...card, components: enriched });
      }
      result.push({ ...component, type: 'CAROUSEL', cards });
      continue;
    }
    result.push(component);
  }
  return result;
}

module.exports = {
  attachHeaderMediaExample,
  enrichComponentsWithHeaderExamples,
  uploadResumableMediaHandle,
  formatAxiosMetaError,
  withMetaRateLimitRetry,
  isMetaRateLimitError,
};
