const db = require('../config/db');
const Project = require('../models/Project');
const { AgentProject, User } = require('../models');

const TEAM_ROLES = new Set(['agent', 'manager']);

function normalizeRole(role) {
  return String(role || '').toLowerCase().trim();
}

async function getActiveProjectIdsForAgent(agentId) {
  const aid = Number(agentId);
  if (!Number.isInteger(aid) || aid <= 0) return [];

  const rows = await AgentProject.findAll({
    where: { agentId: aid, isActive: true },
    attributes: ['projectId'],
  });

  return [...new Set(rows.map((row) => Number(row.projectId)).filter((id) => id > 0))];
}

async function assignAgentToProject(agentId, projectId, assignedBy = null) {
  const aid = Number(agentId);
  const pid = Number(projectId);
  if (!Number.isInteger(aid) || aid <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const assignedById =
    assignedBy != null && Number.isInteger(Number(assignedBy)) && Number(assignedBy) > 0
      ? Number(assignedBy)
      : null;

  const [row] = await AgentProject.findOrCreate({
    where: { agentId: aid, projectId: pid },
    defaults: {
      agentId: aid,
      projectId: pid,
      assignedBy: assignedById,
      assignedAt: new Date(),
      isActive: true,
    },
  });

  if (!row.isActive) {
    row.isActive = true;
    row.assignedAt = new Date();
    if (assignedById) row.assignedBy = assignedById;
    await row.save();
  }

  return row;
}

async function setAgentProjects(agentId, projectIds = [], assignedBy = null) {
  const aid = Number(agentId);
  if (!Number.isInteger(aid) || aid <= 0) return [];

  const desired = [
    ...new Set(
      (Array.isArray(projectIds) ? projectIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];

  const existing = await AgentProject.findAll({ where: { agentId: aid } });
  const existingByProject = new Map(existing.map((row) => [Number(row.projectId), row]));

  for (const pid of desired) {
    await assignAgentToProject(aid, pid, assignedBy);
  }

  for (const row of existing) {
    const pid = Number(row.projectId);
    const shouldBeActive = desired.includes(pid);
    if (row.isActive !== shouldBeActive) {
      row.isActive = shouldBeActive;
      await row.save();
    }
  }

  if (desired.length > 0) {
    const primaryProjectId = desired[0];
    try {
      await User.update({ projectId: primaryProjectId }, { where: { id: aid } });
    } catch (_) {
      /* keep mapping authoritative even if legacy column update fails */
    }
  }

  return getActiveProjectIdsForAgent(aid);
}

async function backfillFromUsersProjectId() {
  try {
    const [rows] = await db.query(`
      SELECT id AS agent_id, projectId AS project_id
      FROM users
      WHERE role IN ('agent', 'manager')
        AND projectId IS NOT NULL
        AND projectId > 0
    `);

    let inserted = 0;
    for (const row of rows || []) {
      const result = await assignAgentToProject(row.agent_id, row.project_id, null);
      if (result) inserted += 1;
    }

    if (inserted > 0) {
      console.log(`✅ agent_projects backfill processed ${inserted} assignment(s) from users.projectId.`);
    }
  } catch (error) {
    console.error('⚠️ agent_projects backfill error:', error?.message || error);
  }
}

async function userHasProjectAccess(user, projectId) {
  const pid = Number(projectId);
  if (!user || !Number.isInteger(pid) || pid <= 0) return false;

  const role = normalizeRole(user.role);
  const userId = Number(user.id);

  if (role === 'super_admin') return true;

  const project = await Project.findById(pid);
  if (!project) return false;

  if (role === 'admin') {
    return Number(project.user_id) === userId;
  }

  if (TEAM_ROLES.has(role)) {
    const assignedIds = await getActiveProjectIdsForAgent(userId);
    if (assignedIds.includes(pid)) return true;

    const legacyProjectId = Number(user.projectId);
    return Number.isInteger(legacyProjectId) && legacyProjectId > 0 && legacyProjectId === pid;
  }

  return Number(project.user_id) === userId;
}

async function listProjectsForUser(user) {
  if (!user) return [];

  const role = normalizeRole(user.role);
  const userId = Number(user.id);

  if (role === 'super_admin') {
    return Project.findAll();
  }

  if (role === 'admin') {
    return Project.findByUser(userId);
  }

  if (TEAM_ROLES.has(role)) {
    const ids = await getActiveProjectIdsForAgent(userId);
    const legacyProjectId = Number(user.projectId);
    if (Number.isInteger(legacyProjectId) && legacyProjectId > 0 && !ids.includes(legacyProjectId)) {
      ids.unshift(legacyProjectId);
    }

    const uniqueIds = [...new Set(ids)];
    const projects = [];
    for (const id of uniqueIds) {
      const project = await Project.findById(id);
      if (project) projects.push(project);
    }
    return projects;
  }

  return Project.findByUser(userId);
}

async function listAgentProjectIds(agentId) {
  return getActiveProjectIdsForAgent(agentId);
}

module.exports = {
  assignAgentToProject,
  setAgentProjects,
  backfillFromUsersProjectId,
  userHasProjectAccess,
  listProjectsForUser,
  listAgentProjectIds,
  getActiveProjectIdsForAgent,
};
