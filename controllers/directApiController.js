const jwt = require('jsonwebtoken');
const { authenticateDirectApiCredentials } = require('../utils/directApiCredentials');
const {
  sendDirectApiMessage,
  formatMetaApiErrorMessage,
} = require('../services/directApiMessageService');
const { logDirectApi, maskBearer } = require('../utils/directApiLogger');
const {
  getProfileDirectApi,
  getBusinessInfoDirectApi,
} = require('../services/aisensyDirectApiClient');
const {
  getMetaBusinessProfileDetails,
  getMetaWabaInformation,
} = require('../services/metaProfileService');

function buildDirectApiJwtPayload({ user, project, projectId, ownerId, externalProjectId }) {
  return {
    id: String(user.id),
    name: String(project?.project_name || user.name || '').trim() || user.name,
    appName: String(process.env.APP_NAME || 'AiSensy').trim(),
    clientId: String(ownerId || user.id),
    activePlan: String(process.env.DIRECT_API_DEFAULT_PLAN || 'FREE_FOREVER').trim(),
    directApi: true,
    projectId: externalProjectId || projectId,
  };
}

exports.regenerateToken = async (req, res) => {
  try {
    logDirectApi('DIRECT_API_INCOMING_REGENERATE_TOKEN', {
      method: req.method,
      url: req.originalUrl,
      headers: {
        authorization: maskBearer(req.headers.authorization),
        'content-type': req.headers['content-type'],
      },
    }, req.body || null, { note: 'received on Waabizx server' });

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: 'Server configuration error' });
    }

    let auth;
    try {
      auth = await authenticateDirectApiCredentials(req.headers.authorization);
    } catch (err) {
      const status = Number(err.statusCode) || 401;
      const body = { message: err.message || 'Invalid Key' };
      logDirectApi('DIRECT_API_REGENERATE_TOKEN_REJECTED', {
        method: req.method,
        url: req.originalUrl,
      }, req.body || null, body);
      return res.status(status).json(body);
    }

    const directApi = req.body?.direct_api !== false;
    const payload = buildDirectApiJwtPayload(auth);
    const signOptions = directApi ? {} : { expiresIn: '24h' };

    const token = jwt.sign(payload, process.env.JWT_SECRET, signOptions);
    const responseBody = {
      users: [{ token }],
      ...(directApi ? {} : { expiresIn: 86400 }),
    };

    logDirectApi('DIRECT_API_INCOMING_REGENERATE_TOKEN_OK', {
      method: 'POST',
      url: req.originalUrl,
      email: auth.user.email,
      projectId: auth.externalProjectId || auth.projectId,
    }, req.body || null, responseBody);

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error('[direct-api] regenerate-token:', error?.message || error);
    return res.status(500).json({
      message: 'Server error',
    });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const phoneNumberId = String(req.params.phoneNumberId || req.body?.phone_number_id || '').trim();
    logDirectApi('DIRECT_API_INCOMING_SEND_MESSAGE', {
      method: req.method,
      url: req.originalUrl,
      phoneNumberId,
      headers: { authorization: maskBearer(req.headers.authorization) },
    }, req.body || null, { note: 'received on Waabizx server' });

    if (!phoneNumberId) {
      return res.status(400).json({ message: 'phoneNumberId is required' });
    }

    const result = await sendDirectApiMessage({
      phoneNumberId,
      projectId: req.projectId,
      clientId: req.directApiClientId || req.user?.id,
      body: req.body || {},
      isMarketing: false,
    });

    logDirectApi('DIRECT_API_INCOMING_SEND_MESSAGE_OK', {
      method: 'POST',
      url: req.originalUrl,
      phoneNumberId,
    }, req.body || null, { status: result.status, data: result.data });
    return res.status(result.status || 200).json(result.data);
  } catch (error) {
    const status = Number(error.statusCode) || Number(error.response?.status) || 500;
    const message = formatMetaApiErrorMessage(error) || error.message || 'Failed to send message';
    console.error('[direct-api] send message:', message);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      message,
      ...(error.response?.data?.error ? { error: error.response.data.error } : {}),
    });
  }
};

/** AiSensy-style POST /direct-apis/t1/messages — phone_number_id in request body */
exports.sendMessageBody = async (req, res) => {
  req.params = { ...(req.params || {}), phoneNumberId: req.body?.phone_number_id || req.body?.phoneNumberId };
  return exports.sendMessage(req, res);
};

exports.sendMarketingMessage = async (req, res) => {
  try {
    const phoneNumberId = String(req.params.phoneNumberId || req.body?.phone_number_id || '').trim();
    if (!phoneNumberId) {
      return res.status(400).json({ message: 'phoneNumberId is required' });
    }

    const result = await sendDirectApiMessage({
      phoneNumberId,
      projectId: req.projectId,
      clientId: req.directApiClientId || req.user?.id,
      body: req.body || {},
      isMarketing: true,
    });

    return res.status(result.status || 200).json(result.data);
  } catch (error) {
    const status = Number(error.statusCode) || Number(error.response?.status) || 500;
    const message = formatMetaApiErrorMessage(error) || error.message || 'Failed to send message';
    console.error('[direct-api] send marketing message:', message);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      message,
      ...(error.response?.data?.error ? { error: error.response.data.error } : {}),
    });
  }
};

exports.sendMarketingMessageBody = async (req, res) => {
  req.params = { ...(req.params || {}), phoneNumberId: req.body?.phone_number_id || req.body?.phoneNumberId };
  return exports.sendMarketingMessage(req, res);
};

/**
 * GET /direct-apis/t1/get-profile
 * AiSensy: Get Business Profile Details — Bearer JWT, no body/query payload.
 * Response: { profileData: [ ... ] }
 */
exports.getProfile = async (req, res) => {
  try {
    logDirectApi(
      'DIRECT_API_INCOMING_GET_PROFILE',
      {
        method: req.method,
        url: req.originalUrl,
        headers: { authorization: maskBearer(req.headers.authorization) },
      },
      null,
      { note: 'received on Waabizx server' }
    );

    const clientId = req.directApiClientId || req.user?.id;
    const projectId = req.projectId;
    const result = await getMetaBusinessProfileDetails(clientId, projectId);
    const body = { profileData: result.profileData };

    logDirectApi(
      'DIRECT_API_INCOMING_GET_PROFILE_OK',
      { method: 'GET', url: req.originalUrl, projectId },
      null,
      body
    );

    return res.status(200).json(body);
  } catch (error) {
    const status = Number(error.statusCode) || Number(error.response?.status) || 500;
    const message =
      formatMetaApiErrorMessage(error) || error.message || 'Failed to get business profile';
    console.error('[direct-api] get-profile:', message);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ message });
  }
};

/**
 * GET /direct-apis/t1/get-business-info
 * AiSensy: Get WABA Information — Bearer JWT, optional ?fields=id,currency,name
 * Response: { data: { ... } }
 */
exports.getBusinessInfo = async (req, res) => {
  try {
    const fields = String(req.query?.fields || '').trim();
    logDirectApi(
      'DIRECT_API_INCOMING_GET_BUSINESS_INFO',
      {
        method: req.method,
        url: req.originalUrl,
        headers: { authorization: maskBearer(req.headers.authorization) },
      },
      fields ? { fields } : null,
      { note: 'received on Waabizx server' }
    );

    const clientId = req.directApiClientId || req.user?.id;
    const projectId = req.projectId;
    const result = await getMetaWabaInformation(clientId, projectId, fields);
    const body = { data: result.data };

    logDirectApi(
      'DIRECT_API_INCOMING_GET_BUSINESS_INFO_OK',
      { method: 'GET', url: req.originalUrl, projectId, fields: fields || null },
      fields ? { fields } : null,
      body
    );

    return res.status(200).json(body);
  } catch (error) {
    const status = Number(error.statusCode) || Number(error.response?.status) || 500;
    const message =
      formatMetaApiErrorMessage(error) || error.message || 'Failed to get WABA information';
    console.error('[direct-api] get-business-info:', message);
    if (status === 401) {
      return res.status(401).json({ message: 'Invalid Token!' });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({ message });
  }
};

/**
 * Session-auth wrappers for the dashboard website.
 * Calls official AiSensy Direct APIs (same URLs as docs) using project Direct API JWT.
 */
exports.getProfileForSession = async (req, res) => {
  try {
    const projectId =
      req.headers['x-project-id'] ||
      req.query?.projectId ||
      req.query?.project_id ||
      null;
    const userId = req.user?.id;

    let body = { success: true };
    let profileSource = 'meta_graph';

    try {
      const result = await getProfileDirectApi({
        userId,
        projectId,
        localProjectId: projectId,
      });
      body = {
        success: true,
        source: 'aisensy_direct_api',
        ...result.data,
      };
      profileSource = 'aisensy_direct_api';
    } catch (aisensyErr) {
      body.aisensyError = aisensyErr.message;
    }

    try {
      const meta = await getMetaBusinessProfileDetails(userId, projectId);
      const displayName =
        meta.displayName ||
        meta.profileData?.[0]?.display_name ||
        meta.profileData?.[0]?.verified_name ||
        '';
      const metaProfileRows = Array.isArray(meta.profileData) ? meta.profileData : [];
      const existingRows = Array.isArray(body.profileData) ? body.profileData : [];

      body.displayName = displayName;
      body.profileData = existingRows.length
        ? existingRows.map((row, index) => {
            const metaRow = metaProfileRows[index] || metaProfileRows[0] || {};
            return {
              ...row,
              display_name: row.display_name || metaRow.display_name || displayName,
              verified_name: row.verified_name || metaRow.verified_name || displayName,
              name_status: row.name_status || metaRow.name_status || '',
              display_phone_number:
                row.display_phone_number || metaRow.display_phone_number || '',
            };
          })
        : metaProfileRows;
    } catch (metaErr) {
      body.metaError = metaErr.message;
      if (!body.profileData) body.profileData = [];
      if (!body.displayName) body.displayName = '';
    }

    if (profileSource === 'meta_graph' && !body.source) {
      body.source = 'meta_graph_fallback';
    }

    return res.status(200).json(body);
  } catch (error) {
    return res.status(200).json({
      success: true,
      profileData: [],
      displayName: '',
      message: error.message || 'Failed to get business profile',
    });
  }
};

exports.getBusinessInfoForSession = async (req, res) => {
  try {
    const projectId =
      req.headers['x-project-id'] ||
      req.query?.projectId ||
      req.query?.project_id ||
      null;
    const fields = String(req.query?.fields || '').trim();

    try {
      const result = await getBusinessInfoDirectApi({
        projectId,
        localProjectId: projectId,
        fields,
      });
      return res.status(200).json({
        success: true,
        source: 'aisensy_direct_api',
        ...result.data,
      });
    } catch (aisensyErr) {
      const meta = await getMetaWabaInformation(req.user.id, projectId, fields);
      return res.status(200).json({
        success: true,
        source: 'meta_graph_fallback',
        data: meta.data,
        aisensyError: aisensyErr.message,
      });
    }
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status === 401) {
      return res.status(401).json({ success: false, message: 'Invalid Token!' });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: error.message || 'Failed to get WABA information',
    });
  }
};
