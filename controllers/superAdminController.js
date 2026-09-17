const { User, Contact } = require("../models");
const Project = require("../models/Project");
const db = require("../config/db");
const {
  estimateRemainingMessages,
  getCreditUnitCost,
} = require("../services/wccWalletSummaryService");
const { ensureWccSettingsSchema } = require("../services/wccSettingsService");

/** Prefer readable Latin text; recover common UTF-8 misreads; English fallbacks for Super Admin UI. */
function fixTextEncoding(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const isReadableLatin = (s) => /^[\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF.'\-@+()]+$/.test(s);

  if (isReadableLatin(raw)) return raw;

  try {
    const recovered = Buffer.from(raw, "latin1").toString("utf8").trim();
    if (recovered && isReadableLatin(recovered)) return recovered;
  } catch (_) {
    /* ignore */
  }

  return "";
}

function formatPhoneEnglish(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return `+${digits}`;
}

function buildEnglishContactDisplay(contact) {
  const row = contact?.toJSON ? contact.toJSON() : { ...contact };
  const phoneRaw = String(row.phone || "").trim();
  const phoneFormatted = formatPhoneEnglish(phoneRaw) || phoneRaw || "";

  let name = fixTextEncoding(row.name);
  const email = fixTextEncoding(row.email) || String(row.email || "").trim();

  const hasCjk = (s) => /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(s);
  if (!name || name === phoneRaw || hasCjk(name)) {
    name = phoneFormatted
      ? `Contact ${phoneFormatted}`
      : `Contact #${row.id}`;
  }

  const status = String(row.status || "active").toLowerCase();

  return {
    ...row,
    name,
    email: email || null,
    displayName: name,
    displayPhone: phoneFormatted || phoneRaw || "Not provided",
    displayEmail: email || "Not provided",
    displayStatus: status === "inactive" ? "Inactive" : status === "unsubscribed" ? "Unsubscribed" : "Active",
  };
}

exports.getAllAdmins = async (req, res) => {
  try {
    const admins = await User.findAll({
      where: { role: "admin" },
      attributes: ["id", "name", "email", "status", "lastLogin", "createdAt"],
      order: [["createdAt", "DESC"]],
    });

    res.json(admins);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

exports.getAdminContacts = async (req, res) => {
  try {
    const adminId = Number(req.params.adminId);
    if (!adminId || Number.isNaN(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid admin id" });
    }

    const contacts = await Contact.findAll({
      where: { userId: adminId },
      order: [["createdAt", "DESC"]],
    });

    res.json(contacts.map(buildEnglishContactDisplay));
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

/**
 * Super Admin overview: one row per project owned by an admin.
 * Business name = admin login name; plus project, WCC, plan start / renewal.
 */
exports.getBusinessOverview = async (req, res) => {
  try {
    const businesses = await loadBusinessOverviewRows(req.query || {});
    return res.json({
      success: true,
      businesses,
      total: businesses.length,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load business overview",
    });
  }
};

/** CSV download for Partner WCC report (date range optional). */
exports.downloadBusinessWccReport = async (req, res) => {
  try {
    const from = String(req.query.from || req.query.dateFrom || "").trim();
    const to = String(req.query.to || req.query.dateTo || "").trim();
    const businesses = await loadBusinessOverviewRows({ from, to });

    const escapeCsv = (value) => {
      const raw = value == null ? "" : String(value);
      if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };
    const formatDate = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toISOString().slice(0, 10);
    };

    const header = [
      "Business Name",
      "Login Email",
      "Project Name",
      "WCC Count",
      "Plan",
      "Plan Cycle",
      "Plan Active",
      "Plan Start On",
      "Plan Renewal Date",
    ];
    const lines = [header.join(",")];
    for (const row of businesses) {
      lines.push(
        [
          escapeCsv(row.businessName),
          escapeCsv(row.adminEmail),
          escapeCsv(row.projectName),
          escapeCsv(row.wccCount),
          escapeCsv(row.planSlug),
          escapeCsv(row.planCycle),
          escapeCsv(row.planActive ? "Yes" : "No"),
          escapeCsv(formatDate(row.planStartOn)),
          escapeCsv(formatDate(row.planRenewalDate)),
        ].join(",")
      );
    }

    const csv = `\uFEFF${lines.join("\n")}`;
    const fromLabel = from || "all";
    const toLabel = to || "all";
    const filename = `partner-wcc-report_${fromLabel}_to_${toLabel}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to download WCC report",
    });
  }
};

async function verifySameAdminProjects(sourceProjectId, targetProjectId) {
  const sourceId = Number(sourceProjectId);
  const targetId = Number(targetProjectId);
  if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
    return { ok: false, message: "Invalid project id" };
  }
  if (sourceId === targetId) {
    return { ok: false, message: "Source and target project must be different" };
  }
  const [rows] = await db.query(
    `SELECT id, user_id, project_name FROM projects WHERE id IN (?, ?)`,
    [sourceId, targetId]
  );
  const source = rows?.find((r) => Number(r.id) === sourceId);
  const target = rows?.find((r) => Number(r.id) === targetId);
  if (!source || !target) {
    return { ok: false, message: "Project not found" };
  }
  if (Number(source.user_id) !== Number(target.user_id)) {
    return { ok: false, message: "Projects must belong to the same admin account" };
  }
  return {
    ok: true,
    source,
    target,
    adminId: Number(source.user_id),
  };
}

/** Super-admin: transfer subscription plan from one project to another (same admin). */
exports.transferProjectPlan = async (req, res) => {
  let conn;
  try {
    const sourceProjectId = Number(req.params.projectId);
    const targetProjectId = Number(req.body?.targetProjectId);
    const note = String(req.body?.note || req.body?.reason || "").trim();
    const adjustAmountRaw = req.body?.amount;
    const adjustAmount =
      adjustAmountRaw == null || adjustAmountRaw === ""
        ? null
        : Math.round(Number(adjustAmountRaw) * 100) / 100;

    if (!Number.isInteger(sourceProjectId) || sourceProjectId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid source project id" });
    }
    if (!Number.isInteger(targetProjectId) || targetProjectId <= 0) {
      return res.status(400).json({ success: false, message: "Target project is required" });
    }
    if (adjustAmount != null && (!Number.isFinite(adjustAmount) || adjustAmount < 0)) {
      return res.status(400).json({ success: false, message: "Invalid plan amount" });
    }

    await Project.ensureTable();
    const verified = await verifySameAdminProjects(sourceProjectId, targetProjectId);
    if (!verified.ok) {
      return res.status(400).json({ success: false, message: verified.message });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [sourceRows] = await conn.query(
      `SELECT id, project_name, plan_slug, plan_cycle, plan_purchased_at, plan_renews_on, plan_active,
              plan_amount, plan_remaining_amount, razorpay_payment_id, razorpay_order_id
       FROM projects WHERE id = ? FOR UPDATE`,
      [sourceProjectId]
    );
    const [targetRows] = await conn.query(
      `SELECT id, project_name, plan_slug FROM projects WHERE id = ? FOR UPDATE`,
      [targetProjectId]
    );

    const source = sourceRows?.[0];
    const target = targetRows?.[0];
    if (!source) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Source project not found" });
    }
    if (!target) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Target project not found" });
    }

    const planSlug = String(source.plan_slug || "").trim();
    if (!planSlug) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Source project has no plan to transfer",
      });
    }

    const paidAmount =
      adjustAmount != null
        ? adjustAmount
        : source.plan_amount != null && Number(source.plan_amount) > 0
          ? Number(source.plan_amount)
          : source.plan_remaining_amount != null && Number(source.plan_remaining_amount) > 0
            ? Number(source.plan_remaining_amount)
            : null;

    const remainingAmount =
      paidAmount != null && source.plan_purchased_at && source.plan_renews_on
        ? Project.computePlanRemainingAmount(
            paidAmount,
            source.plan_purchased_at,
            source.plan_renews_on
          )
        : paidAmount;

    await conn.query(
      `UPDATE projects
       SET plan_slug = ?,
           plan_cycle = ?,
           plan_purchased_at = ?,
           plan_renews_on = ?,
           plan_active = 1,
           plan_amount = ?,
           plan_remaining_amount = ?,
           razorpay_payment_id = ?,
           razorpay_order_id = ?
       WHERE id = ?`,
      [
        source.plan_slug,
        source.plan_cycle,
        source.plan_purchased_at,
        source.plan_renews_on,
        paidAmount,
        remainingAmount,
        source.razorpay_payment_id,
        source.razorpay_order_id,
        targetProjectId,
      ]
    );

    await conn.query(
      `UPDATE projects
       SET plan_slug = NULL,
           plan_cycle = NULL,
           plan_purchased_at = NULL,
           plan_renews_on = NULL,
           plan_active = 0,
           plan_amount = NULL,
           plan_remaining_amount = NULL,
           razorpay_payment_id = NULL,
           razorpay_order_id = NULL
       WHERE id = ?`,
      [sourceProjectId]
    );

    await conn.commit();

    const targetProjectName =
      String(target.project_name || verified.target.project_name || "").trim() ||
      `Project #${targetProjectId}`;

    return res.json({
      success: true,
      message: `Plan "${planSlug}" transferred to ${targetProjectName}.`,
      sourceProjectId,
      targetProjectId,
      sourceProjectName: String(source.project_name || "").trim() || `Project #${sourceProjectId}`,
      targetProjectName,
      planSlug: source.plan_slug,
      planCycle: source.plan_cycle,
      planAmount: paidAmount,
      planRemainingAmount: remainingAmount,
      note: note || null,
    });
  } catch (error) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (_) {
        /* ignore */
      }
    }
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to transfer plan",
    });
  } finally {
    if (conn) conn.release();
  }
};

/** Super-admin: adjust per-project WCC (add carry-forward / set balance). */
exports.adjustProjectWcc = async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid project id" });
    }

    const mode = String(req.body?.mode || "add").trim().toLowerCase();
    const amount = Number(req.body?.amount);
    const note = String(req.body?.note || req.body?.reason || "").trim();
    const carryForward = Boolean(req.body?.carryForward);
    const targetProjectIdRaw = req.body?.targetProjectId;
    const targetProjectId =
      targetProjectIdRaw == null || targetProjectIdRaw === ""
        ? null
        : Number(targetProjectIdRaw);

    if (!Number.isFinite(amount)) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    await Project.ensureTable();

    if (targetProjectId && targetProjectId !== projectId) {
      const verified = await verifySameAdminProjects(projectId, targetProjectId);
      if (!verified.ok) {
        return res.status(400).json({ success: false, message: verified.message });
      }

      const transferAmount = Math.floor(Math.abs(amount));
      if (transferAmount <= 0) {
        return res.status(400).json({ success: false, message: "Transfer amount must be greater than zero" });
      }

      const dec = await Project.tryDecrementWccCredits(projectId, null, transferAmount);
      if (!dec.ok) {
        return res.status(400).json({
          success: false,
          message: "Insufficient WCC on source project for this transfer",
        });
      }

      const inc = await Project.tryIncrementWccCredits(targetProjectId, transferAmount);
      if (!inc.ok) {
        await Project.tryIncrementWccCredits(projectId, transferAmount);
        return res.status(400).json({ success: false, message: "Failed to credit target project" });
      }

      const targetBalance = await Project.getWccCredits(targetProjectId);
      const sourceBalance = await Project.getWccCredits(projectId);

      return res.json({
        success: true,
        projectId,
        targetProjectId,
        projectName: String(verified.source.project_name || "").trim() || `Project #${projectId}`,
        targetProjectName: String(verified.target.project_name || "").trim() || `Project #${targetProjectId}`,
        previousBalance: sourceBalance + transferAmount,
        balance: sourceBalance,
        targetBalance,
        adjustedBy: transferAmount,
        mode: "transfer",
        note: note || null,
        carryForward,
        remainingEstimatedMessages: estimateRemainingMessages(targetBalance),
        creditUnitCost: getCreditUnitCost(),
        message: `Transferred ${transferAmount} WCC to ${verified.target.project_name || "target project"}.`,
      });
    }

    const applyProjectId = targetProjectId || projectId;
    const [projectRows] = await db.query(
      "SELECT id, project_name, COALESCE(wcc_credits, 0) AS wcc_credits FROM projects WHERE id = ? LIMIT 1",
      [applyProjectId]
    );
    if (!projectRows?.[0]) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }

    const previousBalance = Number(projectRows[0].wcc_credits) || 0;
    const result = await Project.adjustWccCredits(applyProjectId, { mode, amount });
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: result.message || "Failed to adjust WCC",
      });
    }

    return res.json({
      success: true,
      projectId: applyProjectId,
      projectName: String(projectRows[0].project_name || "").trim() || `Project #${applyProjectId}`,
      previousBalance,
      balance: result.balance,
      adjustedBy: result.adjustedBy ?? amount,
      mode,
      note: note || null,
      carryForward,
      remainingEstimatedMessages: estimateRemainingMessages(result.balance),
      creditUnitCost: getCreditUnitCost(),
      message:
        mode === "set"
          ? `WCC balance set to ${result.balance} for this project.`
          : `WCC adjusted by ${amount} for this project.`,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to adjust project WCC",
    });
  }
};

async function loadBusinessOverviewRows(filters = {}) {
  await Project.ensureTable();
  await ensureWccSettingsSchema();

  const from = String(filters.from || filters.dateFrom || "").trim();
  const to = String(filters.to || filters.dateTo || "").trim();

  const params = [];
  let dateClause = "";
  if (from && to) {
    dateClause = ` AND (
      (p.plan_purchased_at IS NOT NULL AND DATE(p.plan_purchased_at) BETWEEN ? AND ?)
      OR (p.plan_renews_on IS NOT NULL AND DATE(p.plan_renews_on) BETWEEN ? AND ?)
      OR (p.created_at IS NOT NULL AND DATE(p.created_at) BETWEEN ? AND ?)
    )`;
    params.push(from, to, from, to, from, to);
  } else if (from) {
    dateClause = ` AND (
      (p.plan_purchased_at IS NOT NULL AND DATE(p.plan_purchased_at) >= ?)
      OR (p.plan_renews_on IS NOT NULL AND DATE(p.plan_renews_on) >= ?)
      OR (p.created_at IS NOT NULL AND DATE(p.created_at) >= ?)
    )`;
    params.push(from, from, from);
  } else if (to) {
    dateClause = ` AND (
      (p.plan_purchased_at IS NOT NULL AND DATE(p.plan_purchased_at) <= ?)
      OR (p.plan_renews_on IS NOT NULL AND DATE(p.plan_renews_on) <= ?)
      OR (p.created_at IS NOT NULL AND DATE(p.created_at) <= ?)
    )`;
    params.push(to, to, to);
  }

  const [rows] = await db.query(
    `SELECT
       p.id AS project_id,
       p.project_name,
       COALESCE(p.wcc_credits, 0) AS wcc_credits,
       COALESCE(p.wcc_extra_credits, 0) AS wcc_extra_credits,
       p.plan_slug,
       p.plan_cycle,
       p.plan_purchased_at,
       p.plan_renews_on,
       p.plan_active,
       p.plan_amount,
       p.plan_remaining_amount,
       p.created_at AS project_created_at,
       u.id AS admin_id,
       u.name AS admin_name,
       u.email AS admin_email,
       u.status AS admin_status,
       u.lastLogin AS admin_last_login,
       u.currency AS admin_currency
     FROM projects p
     INNER JOIN users u ON u.id = p.user_id
     WHERE u.role = 'admin'${dateClause}
     ORDER BY u.name ASC, p.project_name ASC`,
    params
  );

  return (Array.isArray(rows) ? rows : []).map((row) => {
    const businessName =
      String(row.admin_name || "").trim() ||
      String(row.admin_email || "").trim() ||
      `Admin #${row.admin_id}`;
    const renewsOn = row.plan_renews_on ? new Date(row.plan_renews_on) : null;
    const purchasedAt = row.plan_purchased_at ? new Date(row.plan_purchased_at) : null;
    const activeFlag = Number(row.plan_active) === 1;
    const notExpired = !renewsOn || renewsOn.getTime() >= Date.now();
    const planActive = activeFlag && notExpired && Boolean(row.plan_slug);

    return {
      adminId: Number(row.admin_id),
      businessName,
      adminEmail: row.admin_email || null,
      adminStatus: row.admin_status || null,
      adminLastLogin: row.admin_last_login || null,
      adminCurrency: String(row.admin_currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR',
      projectId: Number(row.project_id),
      projectName: String(row.project_name || "").trim() || `Project #${row.project_id}`,
      wccCount: Number(row.wcc_credits) || 0,
      wccRemainingCredits: Number(row.wcc_credits) || 0,
      wccExtraCredits: Number(row.wcc_extra_credits) || 0,
      remainingEstimatedMessages: estimateRemainingMessages(Number(row.wcc_credits) || 0),
      creditUnitCost: getCreditUnitCost(),
      planSlug: row.plan_slug || null,
      planCycle: row.plan_cycle || null,
      planAmount: row.plan_amount != null ? Number(row.plan_amount) : null,
      planRemainingAmount:
        row.plan_remaining_amount != null ? Number(row.plan_remaining_amount) : null,
      planActive,
      planStartOn: purchasedAt && !Number.isNaN(purchasedAt.getTime())
        ? purchasedAt.toISOString()
        : null,
      planRenewalDate: renewsOn && !Number.isNaN(renewsOn.getTime())
        ? renewsOn.toISOString()
        : null,
      projectCreatedAt: row.project_created_at || null,
    };
  });
}
