const jwt = require('jsonwebtoken');
const { User } = require('../models');
const {
  findPartnerBusinessByExternalProjectId,
  findPartnerBusinessByProject,
} = require('../services/partnerBusinessService');

function sendDirectApiAuthError(res, status, message) {
  return res.status(status).json({ message });
}

exports.requireDirectApiJwt = async (req, res, next) => {
  try {
    const raw = String(req.headers.authorization || '').trim();
    if (!raw.toLowerCase().startsWith('bearer ')) {
      return sendDirectApiAuthError(res, 401, 'Unauthorized');
    }

    const token = raw.slice(7).trim();
    if (!token) {
      return sendDirectApiAuthError(res, 401, 'Unauthorized');
    }

    if (!process.env.JWT_SECRET) {
      return sendDirectApiAuthError(res, 500, 'Server configuration error');
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return sendDirectApiAuthError(res, 401, 'Token has expired');
      }
      return sendDirectApiAuthError(res, 401, 'Invalid token');
    }

    if (decoded.directApi !== true) {
      return sendDirectApiAuthError(res, 401, 'Direct API token required');
    }

    const userId = Number(decoded.id || decoded.clientId);
    const user = Number.isInteger(userId) && userId > 0
      ? await User.findByPk(userId, { attributes: { exclude: ['password'] } })
      : null;

    if (!user) {
      return sendDirectApiAuthError(res, 401, 'User not found');
    }

    const rawProjectId = String(decoded.projectId || '').trim();
    let projectId = Number(rawProjectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      const partnerRow = await findPartnerBusinessByExternalProjectId(rawProjectId);
      if (partnerRow?.project_id) {
        projectId = Number(partnerRow.project_id);
      }
    }
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return sendDirectApiAuthError(res, 400, 'Project id missing in token');
    }

    req.user = user;
    req.projectId = projectId;
    req.externalProjectId = /^[a-f0-9]{24}$/i.test(rawProjectId) ? rawProjectId : null;
    req.directApi = true;
    req.directApiClientId = Number(decoded.clientId) || user.id;
    req.directApiClaims = decoded;
    return next();
  } catch (error) {
    console.error('[direct-api] auth:', error?.message || error);
    return sendDirectApiAuthError(res, 500, 'Server error');
  }
};
