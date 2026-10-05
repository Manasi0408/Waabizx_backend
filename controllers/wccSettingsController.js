const {
  listAdminWccSettings,
  updateAdminWccSettings,
  listProjectWccTransactions,
  exportProjectWccTransactions,
} = require('../services/wccSettingsService');

exports.getAdminWccSettings = async (req, res) => {
  try {
    const payload = await listAdminWccSettings();
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load WCC settings',
      error: error.message,
    });
  }
};

exports.updateAdminWccSettings = async (req, res) => {
  try {
    const payload = await updateAdminWccSettings(req.body || {});
    return res.json({
      success: true,
      message: 'WCC settings updated',
      ...payload,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update WCC settings',
      error: error.message,
    });
  }
};

exports.getProjectWccTransactions = async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const offset = (page - 1) * pageSize;
    const payload = await listProjectWccTransactions(projectId, pageSize, offset);
    return res.json({ success: true, page, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load WCC transactions',
      error: error.message,
    });
  }
};

const WCC_CATEGORY_LABELS = {
  marketing: 'Marketing',
  utility: 'Utility',
  authentication: 'Authentication',
  service: 'Service',
};

exports.downloadProjectWccTransactions = async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const payload = await exportProjectWccTransactions(projectId);

    const escapeCsv = (value) => {
      const raw = value == null ? '' : String(value);
      if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };
    const formatDate = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 19).replace('T', ' ');
    };

    const header = [
      'Business Name',
      'Project Name',
      'Current Balance',
      'Date',
      'Category',
      'Deducted',
      'Actual Cost',
      'Extra',
      'Message ID',
      'Status',
    ];
    const lines = [header.join(',')];
    for (const tx of payload.transactions) {
      const category = WCC_CATEGORY_LABELS[tx.category] || tx.category || '';
      lines.push(
        [
          escapeCsv(payload.businessName),
          escapeCsv(payload.projectName),
          escapeCsv(payload.balance),
          escapeCsv(formatDate(tx.createdAt)),
          escapeCsv(category),
          escapeCsv(tx.deducted ?? tx.customerCharge ?? 0),
          escapeCsv(tx.originalAmount ?? 0),
          escapeCsv(tx.extraAmount ?? 0),
          escapeCsv(tx.messageId || ''),
          escapeCsv(tx.status || 'completed'),
        ].join(',')
      );
    }

    const csv = `\uFEFF${lines.join('\n')}`;
    const safeProject = String(payload.projectName || projectId)
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 60);
    const filename = `wcc-wallet_${safeProject || projectId}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to download WCC wallet transactions',
      error: error.message,
    });
  }
};
