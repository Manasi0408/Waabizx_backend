const { sequelize, Campaign, Contact, Message, User, InboxMessage } = require('../models');
const { Op } = require('sequelize');
const db = require('../config/db');
const { upsertConversationWithQuota, ensureAccountExists } = require('../services/conversationBillingService');
const { requireProjectId, getProjectId } = require('../utils/projectScope');
const Project = require('../models/Project');
const { getWabaTierForProject } = require('../services/wabaTierService');
const {
  estimateRemainingMessages,
  getCreditUnitCost,
} = require('../services/wccWalletSummaryService');

exports.getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    // Get time range from query parameter (default to 1 day - Today)
    const daysParam = req.query.days || req.query.range || '1';
    const days = parseInt(daysParam);
    // Validate and set to valid values: 1 (Today), 7, 30, or 90
    const validDays = [1, 7, 30, 90].includes(days) ? days : 1;

    // Total Contacts
    const totalContacts = await Contact.count({ where: { userId, projectId } });

    // Active Campaigns
    const activeCampaigns = await Campaign.count({ 
      where: { 
        userId,
        projectId,
        status: 'active'
      }
    });

    // Messages Today - Count from InboxMessage table
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const messagesToday = await InboxMessage.count({
      where: {
        userId: userId,
        projectId,
        direction: 'outgoing',
        timestamp: {
          [Op.gte]: today
        }
      }
    });

    // Delivery Rate (last 7 days - keep this fixed) - Use InboxMessage table
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const messagesLast7Days = await sequelize.query(`
      SELECT 
        COUNT(im.id) as total,
        SUM(CASE WHEN im.status IN ('delivered', 'read') THEN 1 ELSE 0 END) as delivered
      FROM inboxmessages im
      WHERE im.userId = :userId
        AND im.projectId = :projectId
        AND im.direction = 'outgoing'
        AND im.timestamp >= :sevenDaysAgo
    `, {
      replacements: { userId, projectId, sevenDaysAgo },
      type: sequelize.QueryTypes.SELECT
    });

    const { total = 0, delivered = 0 } = messagesLast7Days[0] || {};
    const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 0;

    // Messages chart data (based on selected time range) - Fetch from InboxMessage table
    let formattedChartData = [];
    
    if (validDays === 1) {
      // For "Today", show hourly data
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Fetch messages with timestamps + status so we can build
      // multiple time-series (sent/delivered/read/failed) for the charts.
      const chartData = await sequelize.query(`
        SELECT
          im.timestamp as timestamp,
          im.status as status
        FROM inboxmessages im
        WHERE im.userId = :userId
          AND im.projectId = :projectId
          AND im.direction = 'outgoing'
          AND im.timestamp >= :todayStart
        ORDER BY im.timestamp ASC
      `, {
        replacements: { userId, projectId, todayStart },
        type: sequelize.QueryTypes.SELECT
      });

      // Group messages by local hour
      const hourMap = {
        sent: {},
        delivered: {},
        read: {},
        failed: {},
      };
      chartData.forEach(item => {
        const localDate = new Date(item.timestamp);
        const localHour = localDate.getHours();
        const status = String(item.status || '').toLowerCase();

        if (status === 'delivered') {
          hourMap.delivered[localHour] = (hourMap.delivered[localHour] || 0) + 1;
        } else if (status === 'read') {
          hourMap.read[localHour] = (hourMap.read[localHour] || 0) + 1;
        } else if (status === 'failed') {
          hourMap.failed[localHour] = (hourMap.failed[localHour] || 0) + 1;
        } else {
          // Default to 'sent'
          hourMap.sent[localHour] = (hourMap.sent[localHour] || 0) + 1;
        }
      });

      // Generate all 24 hours for today with correct labels
      for (let hour = 0; hour < 24; hour++) {
        const hourLabel = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`;
        formattedChartData.push({
          name: hourLabel,
          // Keep the old key name so existing Dashboard UI keeps working.
          messages: hourMap.sent[hour] || 0,
          delivered: hourMap.delivered[hour] || 0,
          read: hourMap.read[hour] || 0,
          failed: hourMap.failed[hour] || 0,
        });
      }
    } else {
      // For 7, 30, or 90 days, show daily data
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - validDays);
      daysAgo.setHours(0, 0, 0, 0); // Start of day

      // Fetch real message data from InboxMessage table (grouped by day + status)
      const chartData = await sequelize.query(`
        SELECT
          DATE(im.timestamp) as date,
          im.status as status,
          COUNT(im.id) as count
        FROM inboxmessages im
        WHERE im.userId = :userId
          AND im.projectId = :projectId
          AND im.direction = 'outgoing'
          AND im.timestamp >= :daysAgo
        GROUP BY DATE(im.timestamp), im.status
        ORDER BY DATE(im.timestamp) ASC
      `, {
        replacements: { userId, projectId, daysAgo },
        type: sequelize.QueryTypes.SELECT
      });

      // Create maps of dates with per-status message counts
      const dataMap = {
        sent: {},
        delivered: {},
        read: {},
        failed: {},
      };
      chartData.forEach(item => {
        const dateKey = new Date(item.date).toISOString().split('T')[0];
        const status = String(item.status || '').toLowerCase();
        const count = parseInt(item.count) || 0;

        if (status === 'delivered') {
          dataMap.delivered[dateKey] = count;
        } else if (status === 'read') {
          dataMap.read[dateKey] = count;
        } else if (status === 'failed') {
          dataMap.failed[dateKey] = count;
        } else {
          // Default to sent
          dataMap.sent[dateKey] = count;
        }
      });

      // Generate complete date range with all days filled
      const todayForChart = new Date();
      todayForChart.setHours(0, 0, 0, 0);

      for (let i = validDays - 1; i >= 0; i--) {
        const date = new Date(todayForChart);
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        
        let name;
        if (validDays === 7) {
          // For 7 days, show weekday names
          name = date.toLocaleDateString('en-US', { weekday: 'short' });
        } else {
          // For 30 or 90 days, show date format (MM/DD)
          name = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        formattedChartData.push({
          name: name,
          // Keep the old key name so existing Dashboard UI keeps working.
          messages: dataMap.sent[dateKey] || 0,
          delivered: dataMap.delivered[dateKey] || 0,
          read: dataMap.read[dateKey] || 0,
          failed: dataMap.failed[dateKey] || 0,
        });
      }
    }

    // Recent activities - Build from real timestamps
    const recentCampaigns = await Campaign.findAll({
      where: { userId, projectId },
      limit: 3,
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'name', 'totalRecipients', 'createdAt']
    });

    const recentMessages = await Message.findAll({
      limit: 2,
      include: [
        {
          model: Campaign,
          where: { userId, projectId },
          attributes: ['name'],
          required: true
        }
      ],
      order: [['sentAt', 'DESC']],
      attributes: ['id', 'sentAt']
    });

    // Format activities with sortable timestamp
    const activities = [];
    
    // Add campaign activities
    recentCampaigns.forEach((campaign) => {
      activities.push({
        id: activities.length + 1,
        type: 'campaign',
        message: `Campaign '${campaign.name}' sent to ${campaign.totalRecipients || 0} users`,
        time: formatTimeAgo(campaign.createdAt),
        icon: '📧',
        activityAt: new Date(campaign.createdAt)
      });
    });

    // Add template activities using actual template status and latest real timestamp
    const Template = require('../models').Template;
    const recentTemplates = await Template.findAll({
      where: { userId, projectId },
      limit: 3,
      order: [['updatedAt', 'DESC']],
      attributes: ['id', 'name', 'status', 'createdAt', 'updatedAt']
    });

    recentTemplates.forEach((template) => {
      const status = String(template.status || '').toLowerCase();
      const templateEventAt = template.updatedAt || template.createdAt;
      let message = null;
      let icon = '📄';

      if (status === 'approved') {
        message = `Template '${template.name}' was approved`;
        icon = '✅';
      } else if (status === 'rejected') {
        message = `Template '${template.name}' was rejected`;
        icon = '❌';
      } else if (status === 'draft') {
        message = `New template '${template.name}' created`;
        icon = '📝';
      } else {
        message = `Template '${template.name}' status updated`;
      }

      activities.push({
        id: activities.length + 1,
        type: 'template',
        message,
        time: formatTimeAgo(templateEventAt),
        icon,
        activityAt: new Date(templateEventAt)
      });
    });

    // Sort activities by actual event time (most recent first), then keep top 5
    activities.sort((a, b) => new Date(b.activityAt) - new Date(a.activityAt));
    const topActivities = activities.slice(0, 5).map(({ activityAt, ...rest }) => rest);

    res.json({
      success: true,
      stats: {
        totalContacts,
        activeCampaigns,
        messagesToday,
        deliveryRate: `${deliveryRate}%`
      },
      chartData: formattedChartData,
      activities: topActivities
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Login admin conversation activity aggregated for the last 12 months.
// Project-scoped chat statuses (active / requesting / intervened / closed).
exports.getAgentActivity = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0);

    const lastActivitySql = `(
      SELECT MAX(m.created_at)
      FROM message m
      WHERE m.conversation_id = c.id
    )`;

    const rows = await sequelize.query(`
      SELECT
        DATE_FORMAT(COALESCE(${lastActivitySql}, c.created_at), '%Y-%m') as ym,
        LOWER(TRIM(COALESCE(c.status, ''))) as status,
        COUNT(*) as count
      FROM conversations c
      WHERE c.project_id = :projectId
        AND COALESCE(${lastActivitySql}, c.created_at) IS NOT NULL
        AND COALESCE(${lastActivitySql}, c.created_at) >= :startDate
      GROUP BY ym, status
      ORDER BY ym ASC
    `, {
      replacements: { startDate, projectId },
      type: sequelize.QueryTypes.SELECT,
    });

    const monthDefs = [];
    const statusKeys = ['active', 'closed', 'requesting', 'intervened'];

    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      monthDefs.push({ ym, label });
    }

    const seriesMap = {};
    monthDefs.forEach(m => {
      seriesMap[m.ym] = {
        active: 0,
        closed: 0,
        requesting: 0,
        intervened: 0,
      };
    });

    (rows || []).forEach(row => {
      const ym = row.ym;
      const status = String(row.status || '').toLowerCase();
      const count = parseInt(row.count) || 0;

      if (seriesMap[ym] && statusKeys.includes(status)) {
        seriesMap[ym][status] = count;
      }
    });

    const data = monthDefs.map(m => ({
      name: m.label,
      ...seriesMap[m.ym],
    }));

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

// Helper function to format time ago
function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - new Date(date);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }
}

// WhatsApp conversation-based quota (24-hour rolling).
// Matches the Meta concept: charge per conversation session, not per message.
exports.getConversationQuota = async (req, res) => {
  try {
    const accountId = Number(req.params.accountId);
    if (!accountId || Number.isNaN(accountId)) {
      return res.status(400).json({ success: false, message: 'Invalid account id' });
    }
    if (Number(req.user?.id) !== accountId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    let projectId = getProjectId(req);
    if (!projectId && Number(req.projectId) > 0) {
      projectId = Number(req.projectId);
    }
    if (!projectId) {
      const userProjectId = Number(req.user?.projectId);
      if (Number.isInteger(userProjectId) && userProjectId > 0) {
        projectId = userProjectId;
      }
    }
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'Project is required. Please select a project first.',
      });
    }

    const role = (req.user?.role || '').toString().toLowerCase();
    const projectWideStats = ['agent', 'admin', 'manager', 'super_admin'].includes(role);

    const { limit, name: accountName } = await ensureAccountExists(accountId);
    const ownerUserId = await Project.getProjectOwnerId(projectId);
    const wccBillingUserId =
      ownerUserId != null && Number(ownerUserId) > 0 ? Number(ownerUserId) : Number(accountId);
    const wccCredits = await Project.getWccCredits(projectId, wccBillingUserId);
    const [projectRows] = await db.query(
      'SELECT project_name FROM projects WHERE id = ? LIMIT 1',
      [projectId]
    );
    const projectName =
      String(projectRows?.[0]?.project_name || '').trim() ||
      `Project #${projectId}`;
    const planInfo = await Project.getPlanInfo(projectId);
    const wabaTier = await getWabaTierForProject(projectId, accountId);
    const creditUnitCost = getCreditUnitCost();
    const remainingEstimatedMessages = estimateRemainingMessages(wccCredits);
    // Project-wide distinct conversations in last 24h (all agents on this WABA project).
    const usedRows = await sequelize.query(
      `SELECT COUNT(DISTINCT im.contactId) AS total
       FROM inboxmessages im
       WHERE im.projectId = :projectId
         AND im.direction = 'outgoing'
         AND im.timestamp >= NOW() - INTERVAL 24 HOUR`,
      {
        replacements: { projectId },
        type: sequelize.QueryTypes.SELECT,
      }
    );
    const used = Number(usedRows?.[0]?.total || 0);

    // Template sends today (calendar day, server local midnight)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const templateSentTodayWhere = {
      projectId,
      direction: 'outgoing',
      isTemplateSend: true,
      status: { [Op.in]: ['sent', 'delivered', 'read'] },
      timestamp: { [Op.gte]: todayStart },
    };
    if (!projectWideStats) {
      templateSentTodayWhere.userId = accountId;
    }
    const templatesSentToday = await InboxMessage.count({
      where: templateSentTodayWhere,
    });

    const templatesTodayNum = Number(templatesSentToday) || 0;
    const messagesSentToday = templatesTodayNum;
    const localLimitNum = Number(limit) || 0;
    const metaTierLimit =
      wabaTier?.dailyMessagingLimit != null && Number(wabaTier.dailyMessagingLimit) > 0
        ? Number(wabaTier.dailyMessagingLimit)
        : null;
    const limitNum = metaTierLimit != null ? metaTierLimit : localLimitNum;
    const sentTodayNum = templatesTodayNum;
    const tierRemaining = Math.max(0, limitNum - templatesTodayNum);
    const remaining = tierRemaining;

    console.log('[Dashboard][WCC] Payload for UI', {
      accountId,
      projectId,
      projectName,
      wccCredits,
      remainingEstimatedMessages,
      creditUnitCost,
      wabaTier: wabaTier?.tier,
      wabaTierLabel: wabaTier?.tierLabel,
      metaTierLimit,
      used24hDistinctConversations: used,
      messagesSentToday: sentTodayNum,
      templatesSentToday: templatesTodayNum,
      tierRemaining,
      dailySendLimit: limitNum,
      accountName,
    });

    res.json({
      success: true,
      projectId,
      projectName,
      used,
      remaining,
      limit: limitNum,
      messagesSentToday,
      templatesSentToday,
      accountName,
      wccCredits,
      wccRemainingCredits: wccCredits,
      remainingEstimatedMessages,
      creditUnitCost,
      planInfo,
      wabaTier: wabaTier?.tier || null,
      wabaTierLabel: wabaTier?.tierLabel || null,
      messagingLimitDisplay: wabaTier?.messagingLimitDisplay || null,
      wabaThroughputLevel: wabaTier?.throughputLevel || null,
      wabaQualityRating: wabaTier?.qualityRating || null,
      tierDailyLimit: limitNum,
      tierRemaining,
      tierSource: wabaTier?.source || 'local',
      tierFetchedAt: wabaTier?.fetchedAt || null,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};