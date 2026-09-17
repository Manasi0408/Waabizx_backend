const { Flow, CannedMessage, Campaign, InboxMessage } = require("../models");
const { requireProjectId, getProjectId } = require("../utils/projectScope");
const { enforcePlanLimit } = require('../services/planLimitService');
const { runFlow, parseFlowData } = require('../services/flowExecutionService');
const { convertReactFlowToMetaFlow } = require('../services/reactFlowToMetaFlowConverter');
const {
  resolveMetaFlowApiCredentials,
  resolveMetaFlowEndpointUri,
  shouldUseMetaFlowEndpoint,
  createMetaWhatsAppFlow,
  updateMetaFlowMetadata,
  uploadMetaFlowJson,
  publishMetaFlow,
} = require('../services/metaWhatsAppFlowApiService');
const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const multer = require('multer');
const { toPublicMediaUrl } = require('../utils/templateMessageComponents');

const FLOW_MEDIA_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB (flow video uploads)
const FLOW_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const FLOW_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|3gp|mov|avi|mkv|webm|m4v|mpeg|mpg|wmv|flv|ogv)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|amr)$/i;
const DOCUMENT_EXT = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i;

function inferFlowMediaTypeFromName(filename) {
  const name = String(filename || "").toLowerCase();
  if (VIDEO_EXT.test(name)) return "VIDEO";
  if (AUDIO_EXT.test(name)) return "AUDIO";
  if (IMAGE_EXT.test(name)) return "IMAGE";
  if (DOCUMENT_EXT.test(name)) return "DOCUMENT";
  if (/^flow-media-/i.test(path.basename(name))) return "IMAGE";
  return "DOCUMENT";
}

function classifyUploadMediaType(filename) {
  const name = String(filename || "").toLowerCase();
  if (VIDEO_EXT.test(name)) return "VIDEO";
  if (AUDIO_EXT.test(name)) return "AUDIO";
  if (DOCUMENT_EXT.test(name)) return "DOCUMENT";
  if (IMAGE_EXT.test(name)) return "IMAGE";
  if (/^flow-media-/i.test(path.basename(name))) {
    return inferFlowMediaTypeFromName(name);
  }
  return null;
}

function flowMediaManifestPath() {
  return path.join(__dirname, "../uploads/flow-media-manifest.json");
}

function readFlowMediaManifest() {
  const manifestPath = flowMediaManifestPath();
  try {
    if (!fs.existsSync(manifestPath)) return [];
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function appendFlowMediaManifest(entry) {
  const manifestPath = flowMediaManifestPath();
  const uploadDir = path.dirname(manifestPath);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const list = readFlowMediaManifest();
  const storedPath = entry?.storedPath;
  const next = list.filter((row) => String(row?.storedPath || "") !== String(storedPath || ""));
  next.push({
    storedPath,
    filename: entry?.filename || path.basename(storedPath || ""),
    mediaType: entry?.mediaType || "IMAGE",
    size: Number(entry?.size) || 0,
    userId: entry?.userId || null,
    projectId: entry?.projectId || null,
    uploadedAt: new Date().toISOString(),
  });
  fs.writeFileSync(manifestPath, JSON.stringify(next.slice(-5000)));
}

function resolveUploadFileSize(storedPath, fallback = 0) {
  if (!storedPath) return fallback;
  const uploadDir = path.join(__dirname, "../uploads");
  const full = path.join(uploadDir, path.basename(storedPath));
  try {
    if (full.startsWith(uploadDir) && fs.existsSync(full)) {
      return fs.statSync(full).size || fallback;
    }
  } catch (_) {
    /* ignore */
  }
  return fallback;
}

function toStoredUploadPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const apiIdx = raw.indexOf("/api/uploads/");
  if (apiIdx >= 0) {
    return `/uploads/${raw.slice(apiIdx + "/api/uploads/".length).split(/[?#]/)[0]}`;
  }
  const idx = raw.indexOf("/uploads/");
  if (idx >= 0) return raw.slice(idx).split(/[?#]/)[0];
  if (raw.startsWith("uploads/")) return `/${raw.split(/[?#]/)[0]}`;
  try {
    const pathname = new URL(raw).pathname || "";
    if (pathname.startsWith("/api/uploads/")) {
      return `/uploads/${pathname.slice("/api/uploads/".length).split(/[?#]/)[0]}`;
    }
    const pathIdx = pathname.indexOf("/uploads/");
    if (pathIdx >= 0) return pathname.slice(pathIdx).split(/[?#]/)[0];
  } catch (_) {
    /* ignore */
  }
  return null;
}

function extractUploadPathsFromText(text) {
  const found = [];
  const raw = String(text || "");
  const re = /\/uploads\/[A-Za-z0-9._-]+/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    found.push(match[0]);
  }
  return found;
}

const flowMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `flow-media-${uniqueSuffix}${path.extname(file.originalname || '.bin')}`);
  },
});

const flowMediaUpload = multer({
  storage: flowMediaStorage,
  limits: { fileSize: FLOW_MEDIA_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const extOk =
      IMAGE_EXT.test(name) ||
      VIDEO_EXT.test(name) ||
      AUDIO_EXT.test(name) ||
      DOCUMENT_EXT.test(name);
    if (
      mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      mime.startsWith('audio/') ||
      mime.startsWith('application/') ||
      mime.startsWith('text/') ||
      mime === 'application/octet-stream' ||
      extOk
    ) {
      cb(null, true);
      return;
    }
    cb(new Error('Only image, video, or document files are allowed'));
  },
});

function classifyFlowMediaFile(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  const name = String(file?.originalname || file?.filename || '').toLowerCase();
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) {
    return { type: 'VIDEO', maxBytes: FLOW_MEDIA_MAX_BYTES };
  }
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) {
    return { type: 'AUDIO', maxBytes: FLOW_DOCUMENT_MAX_BYTES };
  }
  if (
    mime === 'application/pdf' ||
    mime.includes('document') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    mime.startsWith('text/') ||
    DOCUMENT_EXT.test(name)
  ) {
    return { type: 'DOCUMENT', maxBytes: FLOW_DOCUMENT_MAX_BYTES };
  }
  return { type: 'IMAGE', maxBytes: FLOW_IMAGE_MAX_BYTES };
}

exports.uploadFlowMediaMiddleware = flowMediaUpload.single('media');

exports.uploadFlowMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No media file uploaded' });
    }

    const { type, maxBytes } = classifyFlowMediaFile(req.file);
    if (req.file.size > maxBytes) {
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      const limitLabel = type === 'VIDEO' ? '1 GB' : type === 'DOCUMENT' ? '100 MB' : '16 MB';
      return res.status(400).json({
        success: false,
        message: `${type === 'VIDEO' ? 'Video' : type === 'DOCUMENT' ? 'Document' : 'Image'} file is too large. Maximum size is ${limitLabel}.`,
      });
    }

    let finalFilename = req.file.filename;
    if (type === 'IMAGE' && req.file.path && fs.existsSync(req.file.path)) {
      const ext = path.extname(req.file.originalname || req.file.filename || '').toLowerCase();
      if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
        try {
          const sharp = require('sharp');
          const convertedPath = req.file.path.replace(/\.[^.]+$/, '') + '.jpg';
          await sharp(req.file.path).rotate().jpeg({ quality: 90, mozjpeg: true }).toFile(convertedPath);
          if (convertedPath !== req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
          finalFilename = path.basename(convertedPath);
        } catch (convertErr) {
          console.warn('[flow] image convert failed:', convertErr?.message || convertErr);
        }
      }
    }

    const publicUrl = toPublicMediaUrl(`/uploads/${finalFilename}`);
    const storedPath = `/uploads/${finalFilename}`;
    const finalSize = resolveUploadFileSize(storedPath, req.file.size);
    appendFlowMediaManifest({
      storedPath,
      filename: req.file.originalname || finalFilename,
      mediaType: type,
      size: finalSize,
      userId: req.user?.id || null,
      projectId: getProjectId(req),
    });
    return res.json({
      success: true,
      url: publicUrl,
      storedPath,
      filename: req.file.originalname,
      mediaType: type,
      size: finalSize,
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload flow media',
    });
  }
};

exports.listFlowMediaLibrary = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = getProjectId(req);

    const filterType = String(req.query.type || "ALL").toUpperCase();
    const items = [];
    const seen = new Set();

    const addItem = ({ storedPath, filename, updatedAt, source, sizeBytes = 0, mediaType: forcedType }) => {
      if (!storedPath) return;
      const mediaType =
        forcedType || classifyUploadMediaType(filename || storedPath) || inferFlowMediaTypeFromName(filename || storedPath);
      if (!mediaType) return;
      if (filterType !== "ALL" && mediaType !== filterType) return;
      const key = storedPath.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const size = sizeBytes || resolveUploadFileSize(storedPath, 0);
      items.push({
        url: storedPath,
        publicUrl: toPublicMediaUrl(storedPath),
        filename: filename || path.basename(storedPath),
        mediaType,
        size,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        source,
      });
    };

    for (const row of readFlowMediaManifest()) {
      const storedPath = toStoredUploadPath(row.storedPath) || row.storedPath;
      if (!storedPath) continue;
      addItem({
        storedPath,
        filename: row.filename || path.basename(storedPath),
        updatedAt: row.uploadedAt,
        source: "manifest",
        sizeBytes: row.size,
        mediaType: row.mediaType,
      });
    }

    const uploadDir = path.join(__dirname, "../uploads");
    if (fs.existsSync(uploadDir)) {
      for (const name of fs.readdirSync(uploadDir)) {
        if (name === "flow-media-manifest.json") continue;
        const full = path.join(uploadDir, name);
        let stat;
        try {
          stat = fs.statSync(full);
        } catch (_) {
          continue;
        }
        if (!stat.isFile()) continue;
        addItem({
          storedPath: `/uploads/${name}`,
          filename: name,
          updatedAt: stat.mtimeMs,
          source: "upload",
          sizeBytes: stat.size,
        });
      }
    }

    if (!projectId) {
      items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const counts = { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 };
      let storageUsedBytes = 0;
      for (const item of items) {
        const t = String(item.mediaType || "").toUpperCase();
        if (counts[t] != null) counts[t] += 1;
        storageUsedBytes += Number(item.size) || 0;
      }
      return res.json({
        success: true,
        media: items.slice(0, 500),
        counts,
        storageUsedBytes,
        storageLimitBytes: FLOW_MEDIA_MAX_BYTES,
      });
    }

    const cannedRows = await CannedMessage.findAll({
      where: { projectId },
      attributes: ["mediaUrl", "mediaFilename", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit: 500,
    });
    for (const row of cannedRows) {
      const storedPath = toStoredUploadPath(row.mediaUrl);
      if (!storedPath) continue;
      addItem({
        storedPath,
        filename: row.mediaFilename || path.basename(storedPath),
        updatedAt: row.updatedAt,
        source: "canned",
      });
    }

    const campaignRows = await Campaign.findAll({
      where: { projectId },
      attributes: ["header_media_url", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit: 500,
    });
    for (const row of campaignRows) {
      const storedPath = toStoredUploadPath(row.header_media_url);
      if (!storedPath) continue;
      addItem({
        storedPath,
        filename: path.basename(storedPath),
        updatedAt: row.updatedAt,
        source: "campaign",
      });
    }

    const flowRows = await Flow.findAll({
      where: { projectId },
      attributes: ["data", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit: 500,
    });
    for (const row of flowRows) {
      const flowData = parseFlowData(row);
      for (const node of flowData.nodes || []) {
        const nodeData = node?.data || {};
        for (const key of ["mediaUrl", "imageUrl", "url", "header_media_url"]) {
          const storedPath = toStoredUploadPath(nodeData[key]);
          if (!storedPath) continue;
          addItem({
            storedPath,
            filename: nodeData.mediaFilename || path.basename(storedPath),
            updatedAt: row.updatedAt,
            source: "flow",
          });
        }
      }
    }

    const inboxRows = await InboxMessage.findAll({
      where: {
        projectId,
        type: { [Op.in]: ['image', 'video', 'document'] },
      },
      attributes: ["message", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit: 500,
    });
    for (const row of inboxRows) {
      for (const storedPath of extractUploadPathsFromText(row.message)) {
        addItem({
          storedPath,
          filename: path.basename(storedPath),
          updatedAt: row.updatedAt,
          source: "inbox",
        });
      }
    }

    items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    const counts = { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 };
    let storageUsedBytes = 0;
    for (const item of items) {
      const t = String(item.mediaType || "").toUpperCase();
      if (counts[t] != null) counts[t] += 1;
      storageUsedBytes += Number(item.size) || 0;
    }

    return res.json({
      success: true,
      media: items.slice(0, 500),
      counts,
      storageUsedBytes,
      storageLimitBytes: FLOW_MEDIA_MAX_BYTES,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load media library",
    });
  }
};

exports.deleteFlowMediaLibrary = async (req, res) => {
  try {
    const bodyUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const queryUrls = Array.isArray(req.query?.urls)
      ? req.query.urls
      : req.query?.urls
        ? [req.query.urls]
        : [];
    const urls = [...bodyUrls, ...queryUrls].filter(Boolean);
    if (!urls.length) {
      return res.status(400).json({ success: false, message: "No media selected" });
    }

    const uploadDir = path.resolve(path.join(__dirname, "../uploads"));
    let deleted = 0;
    const failed = [];

    for (const raw of urls) {
      const storedPath = toStoredUploadPath(raw);
      if (!storedPath || !storedPath.startsWith("/uploads/")) {
        failed.push(String(raw));
        continue;
      }
      const full = path.resolve(path.join(uploadDir, path.basename(storedPath)));
      if (!full.startsWith(uploadDir)) {
        failed.push(String(raw));
        continue;
      }
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        deleted += 1;
      } else {
        failed.push(String(raw));
      }
    }

    if (deleted > 0) {
      try {
        const deletedPaths = new Set(
          urls.map((raw) => toStoredUploadPath(raw)).filter(Boolean)
        );
        const manifest = readFlowMediaManifest().filter(
          (row) => !deletedPaths.has(String(row?.storedPath || ""))
        );
        fs.writeFileSync(flowMediaManifestPath(), JSON.stringify(manifest.slice(-5000)));
      } catch (_) {
        /* ignore manifest cleanup errors */
      }
    }

    if (!deleted) {
      return res.status(404).json({
        success: false,
        deleted: 0,
        failed,
        message: "Could not delete selected file(s). They may already be removed.",
      });
    }

    return res.json({
      success: true,
      deleted,
      failed,
      message: `Deleted ${deleted} file(s)`,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete media",
    });
  }
};

exports.listFlows = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const rows = await Flow.findAll({
      where: { userId, projectId },
      attributes: ['id', 'name', 'status', 'metaFlowId', 'createdAt', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
    });

    return res.json({
      success: true,
      flows: rows.map((f) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        metaFlowId: f.metaFlowId,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.saveFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { name, data } = req.body || {};

    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const edges = Array.isArray(data?.edges) ? data.edges : [];

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Flow name is required' });
    }

    const limitCheck = await enforcePlanLimit(req, res, 'flows');
    if (limitCheck && !limitCheck.allowed) return;

    const created = await Flow.create({
      userId,
      projectId,
      name: String(name).trim(),
      data: JSON.stringify({ nodes, edges }),
    });

    return res.status(201).json({
      success: true,
      message: 'Flow saved successfully',
      flow: {
        id: created.id,
        name: created.name,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.updateFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const flowId = Number(req.params.flowId);
    if (!flowId || Number.isNaN(flowId)) {
      return res.status(400).json({ success: false, message: 'Invalid flow id' });
    }

    const { name, data } = req.body || {};
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const edges = Array.isArray(data?.edges) ? data.edges : [];

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Flow name is required' });
    }

    const flow = await Flow.findOne({
      where: { id: flowId, userId, projectId },
    });

    if (!flow) {
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    await flow.update({
      name: String(name).trim(),
      data: JSON.stringify({ nodes, edges }),
    });

    return res.json({
      success: true,
      message: 'Flow updated successfully',
      flow: {
        id: flow.id,
        name: flow.name,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.deleteFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const flowId = Number(req.params.flowId);
    if (!flowId || Number.isNaN(flowId)) {
      return res.status(400).json({ success: false, message: 'Invalid flow id' });
    }

    const flow = await Flow.findOne({
      where: { id: flowId, userId, projectId },
    });

    if (!flow) {
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    await flow.destroy();

    return res.json({
      success: true,
      message: 'Flow deleted successfully',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.getFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const flowId = Number(req.params.flowId);
    if (!flowId || Number.isNaN(flowId)) {
      return res.status(400).json({ success: false, message: 'Invalid flow id' });
    }

    const flow = await Flow.findOne({
      where: { id: flowId, userId, projectId },
    });

    if (!flow) {
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    return res.json({
      success: true,
      flow: {
        id: flow.id,
        name: flow.name,
        status: flow.status,
        metaFlowId: flow.metaFlowId,
        metaEndpointUri: flow.metaEndpointUri,
        data: parseFlowData(flow),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.executeFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const flowId = Number(req.params.flowId);
    if (!flowId || Number.isNaN(flowId)) {
      return res.status(400).json({ success: false, message: 'Invalid flow id' });
    }

    const flowRow = await Flow.findOne({
      where: { id: flowId, userId, projectId },
    });

    if (!flowRow) {
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    const flowData = parseFlowData(flowRow);
    const { userInput, currentNodeId } = req.body || {};

    const result = runFlow(flowData, { userInput, currentNodeId });
    return res.json({
      success: true,
      output: result.output,
      nextNodeId: result.nextNodeId,
      done: result.done,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.publishFlow = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const flowId = Number(req.params.flowId);
    if (!flowId || Number.isNaN(flowId)) {
      return res.status(400).json({ success: false, message: 'Invalid flow id' });
    }

    const flow = await Flow.findOne({
      where: { id: flowId, userId, projectId },
    });

    if (!flow) {
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    const creds = await resolveMetaFlowApiCredentials(userId, projectId);
    if (!creds?.wabaId || !creds.accessToken) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp Business Account is not connected for this project. Complete Meta onboarding first.',
      });
    }

    const flowData = parseFlowData(flow);
    const useEndpoint = shouldUseMetaFlowEndpoint(req);
    const metaFlowJson = convertReactFlowToMetaFlow({
      name: flow.name,
      nodes: flowData.nodes || [],
      edges: flowData.edges || [],
      useEndpoint,
    });

    const endpointUri = useEndpoint ? resolveMetaFlowEndpointUri(req) : null;
    const categories = Array.isArray(req.body?.categories) && req.body.categories.length
      ? req.body.categories
      : ['LEAD_GENERATION'];

    let metaFlowId = flow.metaFlowId ? String(flow.metaFlowId).trim() : null;

    if (!metaFlowId) {
      const created = await createMetaWhatsAppFlow({
        wabaId: creds.wabaId,
        accessToken: creds.accessToken,
        name: flow.name,
        categories,
        endpointUri,
      });

      if (created?.validation_errors?.length) {
        return res.status(400).json({
          success: false,
          message: 'Meta rejected Flow JSON during create',
          validation_errors: created.validation_errors,
        });
      }

      metaFlowId = created?.id;
      if (!metaFlowId) {
        return res.status(502).json({
          success: false,
          message: 'Meta did not return a Flow ID',
          meta: created,
        });
      }
    } else {
      await updateMetaFlowMetadata({
        flowId: metaFlowId,
        accessToken: creds.accessToken,
        name: flow.name,
        endpointUri,
        categories,
      });
    }

    try {
      const uploadResult = await uploadMetaFlowJson({
        flowId: metaFlowId,
        accessToken: creds.accessToken,
        flowJson: metaFlowJson,
      });

      if (uploadResult?.validation_errors?.length) {
        return res.status(400).json({
          success: false,
          message: 'Meta Flow JSON validation failed',
          validation_errors: uploadResult.validation_errors,
          metaFlowId,
        });
      }
    } catch (uploadErr) {
      return res.status(400).json({
        success: false,
        message: uploadErr.message || 'Failed to upload Flow JSON to Meta',
        validation_errors: uploadErr.validationErrors || [],
        metaFlowId,
      });
    }

    await publishMetaFlow({
      flowId: metaFlowId,
      accessToken: creds.accessToken,
    });

    await flow.update({
      status: 'published',
      metaFlowId,
      metaEndpointUri: endpointUri,
    });

    return res.json({
      success: true,
      message: 'Flow published to Meta WhatsApp Flows',
      metaFlowId,
      status: 'published',
      endpointUri,
      useEndpoint,
      metaFlowJson,
    });
  } catch (error) {
    console.error('publishFlow error:', error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish flow to Meta',
      error: error?.response?.data?.error || error.message,
    });
  }
};
