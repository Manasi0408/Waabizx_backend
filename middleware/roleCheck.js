const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = String(req.user.role || '').toLowerCase().trim();
    const allowedRoles = roles.map((r) => String(r).toLowerCase().trim());
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Access denied. Insufficient permissions.'
      });
    }

    next();
  };
};

const isManager = (req, res, next) => {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  if (!req.user || (role !== 'manager' && role !== 'admin')) {
    return res.status(403).json({ error: 'Admin/Manager access required' });
  }
  next();
};

const isAgent = (req, res, next) => {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  if (!req.user || role !== 'agent') {
    return res.status(403).json({ error: 'Agent access required' });
  }
  next();
};

const isAgentOrManager = (req, res, next) => {
  const role = req.user?.role ? String(req.user.role).toLowerCase() : '';
  if (!req.user) {
    return res.status(403).json({ error: 'Authentication required' });
  }
  if (role !== 'agent' && role !== 'manager' && role !== 'admin') {
    return res.status(403).json({ error: 'Agent or Manager access required' });
  }
  next();
};

module.exports = { authorize, isManager, isAgent, isAgentOrManager };

