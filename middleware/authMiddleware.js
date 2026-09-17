const jwt = require('jsonwebtoken');
const { User } = require('../models');
const {
  ensureUsersCurrentSessionIdColumn,
  readUserSessionId,
  bindUserSessionIdIfEmpty,
} = require('../utils/userSessionStore');
const { checkProjectAccess, isProjectAccessExempt } = require('./projectAccess');
const { getProjectId } = require('../utils/projectScope');

const getProjectIdFromRequest = (req) => {
  const raw =
    req.headers['x-project-id'] ??
    req.headers['x_project_id'] ??
    req.query?.projectId ??
    req.body?.projectId;
  const projectId = Number(raw);
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
};

/**
 * Single active session per account (same email/password login elsewhere invalidates this token).
 * Uses raw SQL for session column read/write so Sequelize column naming cannot break auth.
 */
async function enforceSingleUserSession(userId, decodedSid) {
  const sid = String(decodedSid || '').trim();
  if (!sid) {
    return { ok: false, error: 'SessionInvalidated', message: 'Session expired. Please login again.' };
  }

  await ensureUsersCurrentSessionIdColumn();

  let storedSid = await readUserSessionId(userId);
  if (!storedSid) {
    // Legacy rows / first request after migration: bind once, never overwrite an existing session.
    storedSid = await bindUserSessionIdIfEmpty(userId, sid);
  }

  if (!storedSid || storedSid !== sid) {
    return {
      ok: false,
      error: 'SessionInvalidated',
      message: 'Session expired (logged in elsewhere). Please login again.',
    };
  }

  return { ok: true, storedSid };
}

exports.protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Please include Authorization header with Bearer token',
        error: 'NoToken',
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not set in environment variables');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token has expired. Please login again',
          error: 'TokenExpiredError',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        error: 'JsonWebTokenError',
      });
    }

    const isDirectApiToken = decoded.directApi === true;
    const userId = Number(decoded.id);

    req.user = await User.findByPk(decoded.id, {
      attributes: { exclude: ['password'] },
    });

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
        error: 'UserNotFound',
      });
    }

    if (!isDirectApiToken && Number.isInteger(userId) && userId > 0) {
      const sessionCheck = await enforceSingleUserSession(userId, decoded.sid);
      if (!sessionCheck.ok) {
        return res.status(401).json({
          success: false,
          message: sessionCheck.message,
          error: sessionCheck.error,
        });
      }
      req.user.currentSessionId = sessionCheck.storedSid;
    }

    req.projectId =
      getProjectIdFromRequest(req) ||
      (decoded.projectId != null ? Number(decoded.projectId) : null) ||
      req.user.projectId ||
      null;
    req.directApi = isDirectApiToken;

    if (req.projectId && !isProjectAccessExempt(req)) {
      return checkProjectAccess(req, res, next);
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during authentication',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};
