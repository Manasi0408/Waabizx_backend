const ALLOWED_DISPOSITIONS = new Set([
  'resolved',
  'closed',
  'closed_won',
  'closed_lost',
  'completed',
  'issue_resolved',
  'order_completed',
  'service_completed',
]);

const DISPOSITION_LABELS = {
  resolved: 'Resolved',
  closed: 'Closed',
  closed_won: 'Closed Won',
  closed_lost: 'Closed Lost',
  completed: 'Completed',
  issue_resolved: 'Issue Resolved',
  order_completed: 'Order Completed',
  service_completed: 'Service Completed',
};

function normalizeDisposition(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function getDispositionLabel(value) {
  const key = normalizeDisposition(value);
  return DISPOSITION_LABELS[key] || String(value || '').trim() || 'Resolved';
}

function isAllowedDisposition(value) {
  return ALLOWED_DISPOSITIONS.has(normalizeDisposition(value));
}

module.exports = {
  ALLOWED_DISPOSITIONS,
  DISPOSITION_LABELS,
  normalizeDisposition,
  getDispositionLabel,
  isAllowedDisposition,
};
