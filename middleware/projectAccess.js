const { getProjectId } = require('../utils/projectScope');
const { userHasProjectAccess } = require('../services/agentProjectService');

const PROJECT_ACCESS_EXEMPT_PATHS = [
  '/auth/profile',
  '/auth/agents',
  '/projects/list',
  '/auth/login',
  '/auth/register',
];

function isProjectAccessExempt(req) {
  const path = String(req.originalUrl || req.url || req.path || '').split('?')[0];
  const normalized = path.replace(/^\/api(?=\/|$)/, '') || path;
  const method = String(req.method || 'GET').toUpperCase();

  if (PROJECT_ACCESS_EXEMPT_PATHS.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  )) {
    return true;
  }

  // Account-level project CRUD uses the URL project id, not x-project-id header scope.
  if (normalized === '/projects/create' && method === 'POST') {
    return true;
  }
  if (/^\/projects\/\d+$/.test(normalized) && (method === 'DELETE' || method === 'PATCH')) {
    return true;
  }

  return false;
}

/**
 * Ensures the logged-in user may access the project id on this request.
 * Admin/super_admin use owner rules; agents/managers use agent_projects.
 */
async function verifyProjectAccess(req, res, projectId) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) {
    res.status(400).json({
      success: false,
      message: 'Project ID is required',
    });
    return false;
  }

  const allowed = await userHasProjectAccess(req.user, pid);
  if (!allowed) {
    res.status(403).json({
      success: false,
      message: 'You do not have access to this project',
    });
    return false;
  }

  req.projectId = pid;
  return true;
}

const checkProjectAccess = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const projectId = getProjectId(req);
    if (!projectId) {
      return next();
    }

    if (isProjectAccessExempt(req)) {
      req.projectId = projectId;
      return next();
    }

    const ok = await verifyProjectAccess(req, res, projectId);
    if (!ok) return undefined;
    return next();
  } catch (error) {
    console.error('Project access middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while checking project access',
    });
  }
};

module.exports = {
  checkProjectAccess,
  verifyProjectAccess,
  isProjectAccessExempt,
};
