const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Blog } = require('../models');
const {
  toPermanentUploadPath,
  toPublicMediaUrl,
} = require('../utils/templateMessageComponents');
const { normalizeBlogDetailsHtml, toBlogMediaPublicUrl } = require('../utils/blogDetailsHtml');
const {
  saveBlogMediaFromPath,
  getBlogMedia,
  filenameFromStoredPath,
} = require('../utils/blogMediaStore');

const blogUploadDir = path.join(__dirname, '../uploads/blogs');
if (!fs.existsSync(blogUploadDir)) {
  fs.mkdirSync(blogUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, blogUploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `blog-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extOk = /jpeg|jpg|png|gif|webp/i.test(path.extname(file.originalname || '') || '.jpg');
    const mimeOk = String(file.mimetype || '').startsWith('image/');
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error('Only image files are allowed (jpeg, png, gif, webp).'));
  },
});

exports.uploadBlogImage = upload.single('image');

exports.uploadInlineBlogImage = async (req, res) => {
  try {
    if (!req.file?.filename) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }
    const storedPath = `/uploads/blogs/${req.file.filename}`;
    const abs = path.join(blogUploadDir, req.file.filename);
    if (!fs.existsSync(abs)) {
      return res.status(500).json({
        success: false,
        message: 'Blog image failed to save on disk. Please try again.',
      });
    }
    await saveBlogMediaFromPath(req.file.filename, abs, req.file.mimetype || 'image/jpeg');
    const publicUrl = toBlogMediaPublicUrl(storedPath);
    return res.json({
      success: true,
      url: publicUrl,
      image_url: publicUrl,
      storedPath,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload image',
    });
  }
};

exports.serveBlogMedia = async (req, res) => {
  try {
    const filename = decodeURIComponent(String(req.params.filename || '').trim());
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ success: false, message: 'Invalid media filename' });
    }

    const media = await getBlogMedia(filename);
    if (!media?.buffer?.length) {
      return res.status(404).json({ success: false, message: 'Blog image not found' });
    }

    res.setHeader('Content-Type', media.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(media.buffer);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load blog image',
    });
  }
};

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

async function persistBlogMediaReferences({ image_url, details, file = null }) {
  if (file?.filename) {
    const abs = path.join(blogUploadDir, file.filename);
    await saveBlogMediaFromPath(file.filename, abs, file.mimetype || 'image/jpeg');
  }

  const filenames = new Set();
  const coverName = filenameFromStoredPath(image_url);
  if (coverName) filenames.add(coverName);

  const html = String(details || '');
  const regex = /\/(?:uploads\/blogs|api\/blogs\/media)\/([^"'\\s>?#]+)/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    filenames.add(decodeURIComponent(match[1]));
  }

  for (const filename of filenames) {
    const abs = path.join(blogUploadDir, filename);
    if (fs.existsSync(abs)) {
      await saveBlogMediaFromPath(filename, abs);
    }
  }
}

/** Always persist a relative `/uploads/blogs/...` path (never blob / wrong host). */
function normalizeStoredImageUrl(raw, existing = null) {
  if (raw == null || String(raw).trim() === '') {
    return existing?.image_url || null;
  }
  const permanent = toPermanentUploadPath(raw);
  if (permanent) return permanent;
  const value = String(raw).trim();
  if (value.startsWith('/uploads/')) return value.split('?')[0];
  return existing?.image_url || null;
}

function normalizePayload(body = {}, file = null, existing = null) {
  const title = String(body.title ?? existing?.title ?? '').trim();
  const created_by = String(body.created_by ?? existing?.created_by ?? '').trim();
  const blog_date = String(body.blog_date || body.date || existing?.blog_date || todayDateOnly()).slice(0, 10);
  const meta_title = String(body.meta_title ?? existing?.meta_title ?? '').trim();
  const meta_description = String(body.meta_description ?? existing?.meta_description ?? '').trim();
  const meta_keywords = String(body.meta_keywords ?? existing?.meta_keywords ?? '').trim();
  const detailsRaw = String(body.details ?? existing?.details ?? '');
  const details = normalizeBlogDetailsHtml(detailsRaw, {
    persistDataImages: true,
    forPublic: false,
  });
  const is_active =
    body.is_active === undefined || body.is_active === null
      ? existing?.is_active !== false
      : body.is_active === true ||
        body.is_active === 'true' ||
        body.is_active === '1' ||
        body.is_active === 1;

  let image_url = existing?.image_url || null;
  if (file?.filename) {
    // Permanent on-disk path under backend/uploads/blogs
    image_url = `/uploads/blogs/${file.filename}`;
  } else if (body.clear_image === '1' || body.clear_image === true) {
    image_url = null;
  } else if (body.image_url != null && String(body.image_url).trim() !== '') {
    image_url = normalizeStoredImageUrl(body.image_url, existing);
  }

  return {
    title,
    blog_date,
    created_by,
    image_url,
    meta_title,
    meta_description,
    meta_keywords,
    details,
    is_active: Boolean(is_active),
  };
}

function serializeBlog(blog) {
  const row = blog?.toJSON ? blog.toJSON() : { ...blog };
  const stored = toPermanentUploadPath(row.image_url) || row.image_url || null;
  const publicUrl = stored
    ? stored.startsWith('/uploads/blogs/')
      ? toBlogMediaPublicUrl(stored)
      : toPublicMediaUrl(stored)
    : null;
  const detailsPublic = normalizeBlogDetailsHtml(row.details || '', {
    persistDataImages: false,
    forPublic: true,
  });
  return {
    ...row,
    image_url: publicUrl,
    image_path: stored,
    image_public_url: publicUrl,
    details: detailsPublic,
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseKeywords(raw) {
  return String(raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function toPublicBlog(blog, options = {}) {
  const { includeDetails = true } = options;
  const row = blog?.toJSON ? blog.toJSON() : { ...blog };
  const stored = toPermanentUploadPath(row.image_url) || row.image_url || null;
  const publicUrl = stored
    ? stored.startsWith('/uploads/blogs/')
      ? toBlogMediaPublicUrl(stored)
      : toPublicMediaUrl(stored)
    : null;
  const details = String(row.details || '');
  const detailsPublic = normalizeBlogDetailsHtml(details, {
    persistDataImages: false,
    forPublic: true,
  });
  const metaKeywords = String(row.meta_keywords || '').trim();
  const keywords = parseKeywords(metaKeywords);
  const metaDescription = String(row.meta_description || '').trim();
  const excerptSource = metaDescription || stripHtml(details);
  const excerpt = excerptSource.length > 220 ? `${excerptSource.slice(0, 217)}...` : excerptSource;

  const payload = {
    id: row.id,
    title: row.title || '',
    blog_date: row.blog_date || null,
    date: row.blog_date || null,
    created_by: row.created_by || '',
    author: row.created_by || '',
    image_url: publicUrl,
    image_public_url: publicUrl,
    image_path: stored,
    meta_title: row.meta_title || row.title || '',
    meta_description: metaDescription,
    meta_keywords: metaKeywords,
    keywords,
    excerpt,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };

  if (includeDetails) {
    payload.details = detailsPublic;
    payload.content = detailsPublic;
    payload.body = detailsPublic;
  }

  return payload;
}

exports.listBlogs = async (req, res) => {
  try {
    const blogs = await Blog.findAll({
      order: [
        ['blog_date', 'DESC'],
        ['id', 'DESC'],
      ],
    });

    setImmediate(() => {
      blogs.forEach((blog) => {
        const row = blog?.toJSON ? blog.toJSON() : blog;
        persistBlogMediaReferences({
          image_url: row.image_url,
          details: row.details,
        }).catch(() => {});
      });
    });

    return res.json({ success: true, blogs: blogs.map(serializeBlog) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load blogs',
    });
  }
};

/** Public: list active blogs for external websites (no auth). */
exports.listPublicBlogs = async (req, res) => {
  try {
    const blogs = await Blog.findAll({
      where: { is_active: true },
      order: [
        ['blog_date', 'DESC'],
        ['id', 'DESC'],
      ],
      attributes: [
        'id',
        'title',
        'blog_date',
        'created_by',
        'image_url',
        'meta_title',
        'meta_description',
        'meta_keywords',
        'details',
        'createdAt',
        'updatedAt',
      ],
    });
    return res.json({
      success: true,
      count: blogs.length,
      blogs: blogs.map((b) => toPublicBlog(b, { includeDetails: true })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load blogs',
    });
  }
};

/** Public: single active blog for external websites (no auth). */
exports.getPublicBlog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }
    const blog = await Blog.findOne({
      where: { id, is_active: true },
      attributes: [
        'id',
        'title',
        'blog_date',
        'created_by',
        'image_url',
        'meta_title',
        'meta_description',
        'meta_keywords',
        'details',
        'createdAt',
        'updatedAt',
      ],
    });
    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog not found' });
    }
    return res.json({ success: true, blog: toPublicBlog(blog, { includeDetails: true }) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load blog',
    });
  }
};

exports.getBlog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }
    const blog = await Blog.findByPk(id);
    if (!blog) {
      return res.status(404).json({ success: false, message: 'Blog not found' });
    }
    return res.json({ success: true, blog: serializeBlog(blog) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load blog',
    });
  }
};

exports.createBlog = async (req, res) => {
  try {
    const payload = normalizePayload(req.body, req.file, null);
    if (!payload.title) {
      return res.status(400).json({ success: false, message: 'Blog Title is required' });
    }
    if (!payload.created_by) {
      payload.created_by = String(req.user?.name || req.user?.email || 'SuperAdmin').trim();
    }
    if (!payload.blog_date) {
      return res.status(400).json({ success: false, message: 'Date is required' });
    }

    if (req.file?.filename) {
      const abs = path.join(blogUploadDir, req.file.filename);
      if (!fs.existsSync(abs)) {
        return res.status(500).json({
          success: false,
          message: 'Blog image failed to save on disk. Please try again.',
        });
      }
    }

    const blog = await Blog.create({
      ...payload,
      created_by_user_id: req.user?.id != null ? Number(req.user.id) : null,
    });

    await persistBlogMediaReferences({
      image_url: payload.image_url,
      details: payload.details,
      file: req.file,
    });

    return res.status(201).json({
      success: true,
      blog: serializeBlog(blog),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create blog',
    });
  }
};

exports.updateBlog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }
    const existing = await Blog.findByPk(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Blog not found' });
    }

    const payload = normalizePayload(req.body, req.file, existing);
    if (!payload.title) {
      return res.status(400).json({ success: false, message: 'Blog Title is required' });
    }

    if (req.file?.filename) {
      const abs = path.join(blogUploadDir, req.file.filename);
      if (!fs.existsSync(abs)) {
        return res.status(500).json({
          success: false,
          message: 'Blog image failed to save on disk. Please try again.',
        });
      }
    }

    await existing.update(payload);
    await existing.reload();

    await persistBlogMediaReferences({
      image_url: payload.image_url,
      details: payload.details,
      file: req.file,
    });

    return res.json({ success: true, blog: serializeBlog(existing) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update blog',
    });
  }
};

exports.deleteBlog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }
    const existing = await Blog.findByPk(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Blog not found' });
    }
    await existing.destroy();
    return res.json({ success: true, message: 'Blog deleted' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete blog',
    });
  }
};
