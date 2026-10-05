const getProjectId = (req) => {
  const fromReq = Number(req?.projectId);
  if (Number.isInteger(fromReq) && fromReq > 0) return fromReq;
  const raw =
    req?.headers?.['x-project-id'] ??
    req?.headers?.['x_project_id'] ??
    req?.query?.projectId ??
    req?.body?.projectId;
  const fromHeaderOrQuery = Number(raw);
  if (Number.isInteger(fromHeaderOrQuery) && fromHeaderOrQuery > 0) return fromHeaderOrQuery;
  return null;
};

const requireProjectId = (req, res) => {
  const projectId = getProjectId(req);
  if (!projectId) {
    res.status(400).json({
      success: false,
      message: 'Project is required. Please select a project first.',
    });
    return null;
  }
  return projectId;
};

const withProjectScope = (req, where = {}) => {
  const projectId = getProjectId(req);
  if (!projectId) return { ...where };
  return { ...where, projectId };
};

module.exports = {
  getProjectId,
  requireProjectId,
  withProjectScope,
};
