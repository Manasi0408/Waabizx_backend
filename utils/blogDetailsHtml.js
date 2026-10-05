const fs = require('fs');
const path = require('path');
const { toPermanentUploadPath, toPublicMediaUrl, getUploadsPublicBase } = require('./templateMessageComponents');
const { saveBlogMedia } = require('./blogMediaStore');

const blogUploadDir = path.join(__dirname, '../uploads/blogs');

function toBlogMediaPublicUrl(storedPath) {
  const permanent = toPermanentUploadPath(storedPath) || String(storedPath || '').trim();
  const match = permanent.match(/\/uploads\/blogs\/([^/?#]+)$/i);
  if (!match) return toPublicMediaUrl(storedPath);
  const base = getUploadsPublicBase().replace(/\/$/, '');
  return `${base}/api/blogs/media/${encodeURIComponent(match[1])}`;
}

function ensureBlogUploadDir() {
  if (!fs.existsSync(blogUploadDir)) {
    fs.mkdirSync(blogUploadDir, { recursive: true });
  }
}

function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[String(mime || '').toLowerCase()] || '.jpg';
}

function saveDataUriImage(dataUri) {
  const match = String(dataUri || '').match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  ensureBlogUploadDir();
  const ext = extFromMime(match[1]);
  const filename = `blog-inline-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const abs = path.join(blogUploadDir, filename);
  const buffer = Buffer.from(match[2], 'base64');
  fs.writeFileSync(abs, buffer);
  saveBlogMedia(filename, buffer, match[1]).catch((error) => {
    console.error('saveDataUriImage DB persist error:', error.message || error);
  });
  return `/uploads/blogs/${filename}`;
}

function mergeStyle(existing, additions) {
  const base = String(existing || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const keys = new Set(base.map((part) => part.split(':')[0]?.trim().toLowerCase()).filter(Boolean));
  String(additions || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const key = part.split(':')[0]?.trim().toLowerCase();
      if (key && !keys.has(key)) {
        base.push(part);
        keys.add(key);
      }
    });
  return base.join('; ');
}

function upsertTagStyle(tagHtml, defaults) {
  return String(tagHtml || '').replace(/^<(\w+)([^>]*)>/i, (full, tag, attrs) => {
    const styleMatch = String(attrs || '').match(/\sstyle=(["'])(.*?)\1/i);
    if (styleMatch) {
      const merged = mergeStyle(styleMatch[2], defaults);
      const nextAttrs = String(attrs || '').replace(/\sstyle=(["'])(.*?)\1/i, ` style="${merged}"`);
      return `<${tag}${nextAttrs}>`;
    }
    return `<${tag} style="${defaults}"${attrs || ''}>`;
  });
}

function resolveStoredImgSrc(rawSrc, { persistDataImages = true } = {}) {
  const src = String(rawSrc || '').trim();
  if (!src) return null;
  if (src.startsWith('blob:')) return null;
  if (persistDataImages && src.startsWith('data:image/')) {
    return saveDataUriImage(src);
  }
  const permanent = toPermanentUploadPath(src);
  if (permanent) return permanent;
  if (/^https?:\/\//i.test(src)) return src;
  return null;
}

function resolvePublicImgSrc(rawSrc, options = {}) {
  const stored = resolveStoredImgSrc(rawSrc, options);
  if (!stored) return null;
  if (stored.startsWith('/uploads/blogs/')) return toBlogMediaPublicUrl(stored);
  if (stored.startsWith('/uploads/')) return toPublicMediaUrl(stored);
  return stored;
}

/**
 * Normalize blog HTML for storage or public rendering.
 * - Ensures ul/ol/li render on sites without editor CSS (inline list styles)
 * - Persists data: URI images to /uploads/blogs and rewrites img src
 */
function normalizeBlogDetailsHtml(html, options = {}) {
  const { persistDataImages = true, forPublic = false } = options;
  let out = String(html || '');
  if (!out.trim()) return '';

  out = out.replace(/<ul(\s[^>]*)?>/gi, (match) =>
    upsertTagStyle(match, 'list-style-type: disc; padding-left: 1.5em; margin: 0.75em 0;')
  );
  out = out.replace(/<ol(\s[^>]*)?>/gi, (match) =>
    upsertTagStyle(match, 'list-style-type: decimal; padding-left: 1.5em; margin: 0.75em 0;')
  );
  out = out.replace(/<li(\s[^>]*)?>/gi, (match) =>
    upsertTagStyle(match, 'display: list-item; margin: 0.35em 0;')
  );

  out = out.replace(/<img\b([^>]*?)>/gi, (full, attrs) => {
    const srcMatch = String(attrs || '').match(/\ssrc=(["'])(.*?)\1/i);
    if (!srcMatch) return full;

    const quote = srcMatch[1];
    const rawSrc = srcMatch[2];
    const resolved = forPublic
      ? resolvePublicImgSrc(rawSrc, { persistDataImages })
      : resolveStoredImgSrc(rawSrc, { persistDataImages });

    if (!resolved) return full;

    let nextAttrs = String(attrs || '').replace(/\ssrc=(["'])(.*?)\1/i, ` src=${quote}${resolved}${quote}`);
    if (!/\sstyle=/i.test(nextAttrs)) {
      nextAttrs += ' style="max-width: 100%; height: auto; border-radius: 8px;"';
    } else {
      nextAttrs = nextAttrs.replace(/\sstyle=(["'])(.*?)\1/i, (_m, q, styleValue) => {
        const merged = mergeStyle(styleValue, 'max-width: 100%; height: auto; border-radius: 8px;');
        return ` style=${q}${merged}${q}`;
      });
    }
    return `<img${nextAttrs}>`;
  });

  return out;
}

module.exports = {
  normalizeBlogDetailsHtml,
  saveDataUriImage,
  resolvePublicImgSrc,
  resolveStoredImgSrc,
  toBlogMediaPublicUrl,
};
