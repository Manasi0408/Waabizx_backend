const { Op } = require('sequelize');
const db = require('../config/db');
const Plan = require('../models/Plan');
const Project = require('../models/Project');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const Template = require('../models/Template');
const Flow = require('../models/Flow');
const Contact = require('../models/Contact');
const { parsePlanLimits, buildPlanLimitMessage } = require('../utils/planFeatureLimits');

async function getOwnerProjectIds(projectId) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) return [pid].filter(Boolean);

  let ownerProjectIds = [pid];
  try {
    const [ownerRows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [pid]);
    const ownerId = ownerRows?.[0]?.user_id != null ? Number(ownerRows[0].user_id) : null;
    if (ownerId) {
      const [owned] = await db.query('SELECT id FROM projects WHERE user_id = ?', [ownerId]);
      const ids = (owned || [])
        .map((r) => Number(r.id))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) ownerProjectIds = [...new Set([pid, ...ids])];
    }
  } catch (_) {
    /* keep current project only */
  }
  return ownerProjectIds;
}

async function countAgents(projectId) {
  const ownerProjectIds = await getOwnerProjectIds(projectId);
  let ownerId = null;
  try {
    const [ownerRows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [
      Number(projectId),
    ]);
    ownerId = ownerRows?.[0]?.user_id != null ? Number(ownerRows[0].user_id) : null;
  } catch (_) {
    /* non-fatal */
  }

  const teamWhere = {
    role: { [Op.in]: ['agent', 'manager', 'admin'] },
    projectId: { [Op.in]: ownerProjectIds },
  };
  if (ownerId) {
    teamWhere.id = { [Op.ne]: ownerId };
  }

  return User.count({ where: teamWhere });
}

async function resolveProjectIdForLimit(req, options = {}) {
  const direct = Number(
    options.projectId ??
      req?.projectId ??
      req.headers?.['x-project-id'] ??
      req.headers?.['x_project_id'] ??
      req.body?.projectId ??
      req.query?.projectId
  );
  if (Number.isInteger(direct) && direct > 0) return direct;

  const userId = Number(req?.user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  try {
    const user = await User.findByPk(userId, { attributes: ['projectId'] });
    const fromUser = Number(user?.projectId);
    if (Number.isInteger(fromUser) && fromUser > 0) return fromUser;

    const [rows] = await db.query(
      'SELECT id FROM projects WHERE user_id = ? ORDER BY id ASC LIMIT 1',
      [userId]
    );
    const ownedProjectId = Number(rows?.[0]?.id);
    if (Number.isInteger(ownedProjectId) && ownedProjectId > 0) return ownedProjectId;
  } catch (_) {
    /* non-fatal */
  }

  return null;
}

async function countResource(projectId, resource) {
  const pid = Number(projectId);
  if (!Number.isInteger(pid) || pid <= 0) return 0;

  switch (resource) {
    case 'agents':
      return countAgents(pid);
    case 'campaigns':
      return Campaign.count({ where: { projectId: pid } });
    case 'templates':
      return Template.count({ where: { projectId: pid } });
    case 'flows':
      return Flow.count({ where: { projectId: pid } });
    case 'contacts': {
      const [ownerRows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [pid]);
      const ownerId = Number(ownerRows?.[0]?.user_id) || 0;
      if (!ownerId) return 0;
      return Contact.count({
        where: {
          userId: ownerId,
          [Op.or]: [{ projectId: pid }, { projectId: null }],
        },
      });
    }
    default:
      return 0;
  }
}

async function getPrimaryActivePlanRecord() {
  const plan = await Plan.findOne({
    where: { is_active: true },
    order: [
      ['sort_order', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (!plan) return null;
  const plain = plan.toJSON ? plan.toJSON() : plan;
  return {
    plan: plain,
    limits: parsePlanLimits(plain),
    effectivePlanSlug: String(plain.slug || '').trim().toLowerCase(),
    limitsSource: 'primary_active_plan',
  };
}

async function getProjectPlanRecord(projectId) {
  const planInfo = await Project.getPlanInfo(projectId);
  const assignedSlug = String(planInfo?.plan || '').trim().toLowerCase();

  if (assignedSlug) {
    const plan = await Plan.findOne({ where: { slug: assignedSlug } });
    if (plan) {
      const plain = plan.toJSON ? plan.toJSON() : plan;
      return {
        planInfo,
        plan: plain,
        limits: parsePlanLimits(plain),
        effectivePlanSlug: assignedSlug,
        limitsSource: 'project_plan_slug',
      };
    }
  }

  const fallback = await getPrimaryActivePlanRecord();
  if (fallback) {
    return {
      planInfo,
      plan: fallback.plan,
      limits: fallback.limits,
      effectivePlanSlug: fallback.effectivePlanSlug,
      limitsSource: fallback.limitsSource,
    };
  }

  return { planInfo, plan: null, limits: null, limitsSource: 'none' };
}

async function getProjectPlanLimitsSnapshot(projectId) {
  const { planInfo, plan, limits, effectivePlanSlug, limitsSource } =
    await getProjectPlanRecord(projectId);
  if (!plan || !limits) {
    return {
      active: Boolean(planInfo?.active),
      plan: planInfo?.plan || effectivePlanSlug || null,
      planName: plan?.name || null,
      limits: null,
      usage: {},
      limitsSource: limitsSource || 'none',
    };
  }

  const resources = ['agents', 'campaigns', 'templates', 'flows', 'contacts'];
  const usage = {};
  for (const resource of resources) {
    usage[resource] = {
      limit: limits[resource],
      current: await countResource(projectId, resource),
      unlimited: limits[resource] == null,
    };
  }

  return {
    active: Boolean(planInfo?.active),
    plan: planInfo?.plan || effectivePlanSlug || null,
    planName: plan?.name || null,
    limits,
    usage,
    limitsSource: limitsSource || null,
  };
}

async function checkPlanLimit(projectId, resource, { increment = 1 } = {}) {
  const normalizedResource = String(resource || '').trim().toLowerCase();
  const { planInfo, plan, limits, effectivePlanSlug } = await getProjectPlanRecord(projectId);

  if (!plan || !limits) {
    return { allowed: true, unlimited: true, resource: normalizedResource };
  }

  const limit = limits[normalizedResource];
  if (limit == null) {
    return {
      allowed: true,
      unlimited: true,
      resource: normalizedResource,
      planName: plan?.name || planInfo?.plan || effectivePlanSlug,
      planSlug: plan?.slug || planInfo?.plan || effectivePlanSlug,
    };
  }

  const current = await countResource(projectId, normalizedResource);
  const nextCount = current + Math.max(1, Number(increment) || 1);
  if (nextCount > limit) {
    const message = buildPlanLimitMessage({
      planName: plan?.name || planInfo?.plan || effectivePlanSlug,
      resource: normalizedResource,
      limit,
      current,
    });
    return {
      allowed: false,
      unlimited: false,
      resource: normalizedResource,
      limit,
      current,
      planName: plan?.name || planInfo?.plan || effectivePlanSlug,
      planSlug: plan?.slug || planInfo?.plan || effectivePlanSlug,
      message,
    };
  }

  return {
    allowed: true,
    unlimited: false,
    resource: normalizedResource,
    limit,
    current,
    planName: plan?.name || planInfo?.plan || effectivePlanSlug,
    planSlug: plan?.slug || planInfo?.plan || effectivePlanSlug,
  };
}

function respondPlanLimitExceeded(res, check) {
  return res.status(403).json({
    success: false,
    code: 'PLAN_LIMIT_EXCEEDED',
    message: check.message,
    resource: check.resource,
    limit: check.limit,
    current: check.current,
    planName: check.planName,
    planSlug: check.planSlug,
  });
}

async function enforcePlanLimit(req, res, resource, options = {}) {
  const projectId = await resolveProjectIdForLimit(req, options);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { allowed: true, skipped: true, reason: 'missing_project_id' };
  }

  const check = await checkPlanLimit(projectId, resource, options);
  if (!check.allowed) {
    respondPlanLimitExceeded(res, check);
    return check;
  }
  return check;
}

module.exports = {
  countResource,
  getProjectPlanLimitsSnapshot,
  checkPlanLimit,
  enforcePlanLimit,
  respondPlanLimitExceeded,
  resolveProjectIdForLimit,
};
