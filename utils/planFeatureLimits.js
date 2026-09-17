const RESOURCE_ALIASES = {
  agents: ['agent', 'agents'],
  campaigns: ['campaign', 'campaigns'],
  templates: ['template', 'templates'],
  flows: ['flow', 'flows'],
  contacts: ['contact', 'contacts'],
};

const RESOURCE_LABELS = {
  agents: 'agents',
  campaigns: 'campaigns',
  templates: 'templates',
  flows: 'flows',
  contacts: 'contacts',
};

function normalizeFeatureLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[-•*]\s*/, '')
    .trim();
}

function parseLimitFromFeatureLine(line) {
  const s = normalizeFeatureLine(line);
  if (!s) return null;
  const lower = s.toLowerCase();

  for (const [resource, aliases] of Object.entries(RESOURCE_ALIASES)) {
    for (const alias of aliases) {
      if (lower.includes('unlimited') && lower.includes(alias)) {
        return { resource, limit: null };
      }
      const patterns = [
        new RegExp(`^(\\d+)\\s+${alias}\\b`, 'i'),
        new RegExp(`^(\\d+)\\s+${alias}\\s+can\\s+create\\b`, 'i'),
        new RegExp(`up to\\s+(\\d+)\\s+${alias}\\b`, 'i'),
        new RegExp(`max(?:imum)?\\s+(\\d+)\\s+${alias}\\b`, 'i'),
        new RegExp(`(?:can create|create|add)\\s+(?:up to\\s+)?(\\d+)\\s+${alias}\\b`, 'i'),
        new RegExp(`(\\d+)\\s+${alias}\\s+can\\s+create\\b`, 'i'),
        new RegExp(`(\\d+)\\s+${alias}\\s+only\\b`, 'i'),
        new RegExp(`only\\s+(\\d+)\\s+${alias}\\b`, 'i'),
        new RegExp(`(?:limit|limited to)\\s+(?:of\\s+)?(\\d+)\\s+${alias}\\b`, 'i'),
      ];
      for (const re of patterns) {
        const m = s.match(re);
        if (m) {
          return { resource, limit: Math.max(0, Number(m[1]) || 0) };
        }
      }
    }
  }
  return null;
}

function featuresMentionResource(features, resource) {
  if (!Array.isArray(features)) return false;
  return features.some((line) => parseLimitFromFeatureLine(line)?.resource === resource);
}

function parsePlanLimits(plan) {
  const limits = {
    agents: null,
    campaigns: null,
    templates: null,
    flows: null,
    contacts: null,
  };

  let features = plan?.features;
  if (typeof features === 'string') {
    try {
      features = JSON.parse(features);
    } catch {
      features = String(features)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(features)) {
    features = [];
  }

  // No plan feature lines → all resources unlimited (numeric Users limit is ignored)
  if (features.length === 0) {
    return limits;
  }

  for (const line of features) {
    const parsed = parseLimitFromFeatureLine(line);
    if (parsed && Object.prototype.hasOwnProperty.call(limits, parsed.resource)) {
      limits[parsed.resource] = parsed.limit;
    }
  }

  // users_limit 0 (or empty) = unlimited; only apply when explicitly > 0 and features did not set agents
  const usersLimitRaw = plan?.users_limit;
  const usersLimit =
    usersLimitRaw == null || usersLimitRaw === '' ? 0 : Math.max(0, Number(usersLimitRaw) || 0);
  if (usersLimit > 0 && !featuresMentionResource(features, 'agents')) {
    limits.agents = usersLimit;
  }

  return limits;
}

function buildPlanLimitMessage({ planName, resource, limit, current }) {
  const label = RESOURCE_LABELS[resource] || resource;
  const planLabel = planName || 'your plan';
  return `You are on the ${planLabel} plan, which allows up to ${limit} ${label} only. You currently have ${current} ${label}. Upgrade your plan or remove existing ${label} to add more.`;
}

module.exports = {
  RESOURCE_LABELS,
  parseLimitFromFeatureLine,
  parsePlanLimits,
  buildPlanLimitMessage,
};
