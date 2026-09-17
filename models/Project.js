const db = require('../config/db');

function roundWccAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

class Project {
  static async ensureTable() {
    // Minimal schema; avoids FK issues in existing DBs
    await db.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        project_name VARCHAR(255) NOT NULL,
        whatsapp_number_id VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Backward compatibility for old databases created before whatsapp_number_id.
    try {
      const [cols] = await db.query(`SHOW COLUMNS FROM projects LIKE 'whatsapp_number_id'`);
      if (!Array.isArray(cols) || cols.length === 0) {
        await db.query('ALTER TABLE projects ADD COLUMN whatsapp_number_id VARCHAR(100) NULL');
      }
    } catch (e) {
      // Non-fatal: keep project features working even if alter fails.
      console.error('Could not ensure projects.whatsapp_number_id:', e?.message || e);
    }
    try {
      const [phoneCols] = await db.query(`SHOW COLUMNS FROM projects LIKE 'whatsapp_display_phone'`);
      if (!Array.isArray(phoneCols) || phoneCols.length === 0) {
        await db.query(
          'ALTER TABLE projects ADD COLUMN whatsapp_display_phone VARCHAR(32) NULL'
        );
      }
    } catch (e) {
      console.error('Could not ensure projects.whatsapp_display_phone:', e?.message || e);
    }
    try {
      const [wccCols] = await db.query(`SHOW COLUMNS FROM projects LIKE 'wcc_credits'`);
      if (!Array.isArray(wccCols) || wccCols.length === 0) {
        await db.query(
          'ALTER TABLE projects ADD COLUMN wcc_credits DECIMAL(14,2) NOT NULL DEFAULT 0'
        );
      } else if (wccCols[0] && !String(wccCols[0].Type || '').toLowerCase().includes('decimal')) {
        await db.query(
          'ALTER TABLE projects MODIFY COLUMN wcc_credits DECIMAL(14,2) NOT NULL DEFAULT 0'
        );
      }
    } catch (e) {
      console.error('Could not ensure projects.wcc_credits:', e?.message || e);
    }
    const planCols = [
      ['plan_slug', 'VARCHAR(64) NULL'],
      ['plan_cycle', 'VARCHAR(32) NULL'],
      ['plan_purchased_at', 'DATETIME NULL'],
      ['plan_renews_on', 'DATETIME NULL'],
      ['plan_active', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['razorpay_payment_id', 'VARCHAR(64) NULL'],
      ['razorpay_order_id', 'VARCHAR(64) NULL'],
      ['plan_amount', 'DECIMAL(12,2) NULL'],
      ['plan_remaining_amount', 'DECIMAL(12,2) NULL'],
      ['last_wcc_payment_id', 'VARCHAR(64) NULL'],
      ['last_wcc_purchase_amount', 'DECIMAL(12,2) NULL'],
    ];
    for (const [col, def] of planCols) {
      try {
        const [rows] = await db.query(`SHOW COLUMNS FROM projects LIKE ?`, [col]);
        if (!Array.isArray(rows) || rows.length === 0) {
          await db.query(`ALTER TABLE projects ADD COLUMN ${col} ${def}`);
        }
      } catch (e) {
        console.error(`Could not ensure projects.${col}:`, e?.message || e);
      }
    }
    try {
      const [hiddenCols] = await db.query(`SHOW COLUMNS FROM projects LIKE 'is_hidden'`);
      if (!Array.isArray(hiddenCols) || hiddenCols.length === 0) {
        await db.query(
          'ALTER TABLE projects ADD COLUMN is_hidden TINYINT(1) NOT NULL DEFAULT 0'
        );
      }
    } catch (e) {
      console.error('Could not ensure projects.is_hidden:', e?.message || e);
    }
    await this.ensureProjectNameIndexes();
  }

  /** Per-account project names only; drop erroneous global unique on project_name. */
  static async ensureProjectNameIndexes() {
    try {
      const [indexes] = await db.query('SHOW INDEX FROM projects');
      const indexGroups = {};
      for (const row of indexes || []) {
        const key = row.Key_name;
        if (!indexGroups[key]) indexGroups[key] = [];
        if (!indexGroups[key].includes(row.Column_name)) {
          indexGroups[key].push(row.Column_name);
        }
      }

      for (const [keyName, cols] of Object.entries(indexGroups)) {
        if (keyName === 'PRIMARY') continue;
        const isGlobalProjectNameOnly =
          cols.length === 1 && cols[0] === 'project_name' && keyName !== 'uniq_user_project_name';
        if (isGlobalProjectNameOnly) {
          await db.query(`ALTER TABLE projects DROP INDEX \`${keyName}\``);
        }
      }

      const [indexesAfter] = await db.query('SHOW INDEX FROM projects');
      const groupsAfter = {};
      for (const row of indexesAfter || []) {
        const key = row.Key_name;
        if (!groupsAfter[key]) groupsAfter[key] = [];
        if (!groupsAfter[key].includes(row.Column_name)) {
          groupsAfter[key].push(row.Column_name);
        }
      }
      const hasPerUserUnique = Object.values(groupsAfter).some(
        (cols) =>
          cols.length === 2 && cols.includes('user_id') && cols.includes('project_name')
      );
      if (!hasPerUserUnique) {
        await db.query(
          'ALTER TABLE projects ADD UNIQUE KEY uniq_user_project_name (user_id, project_name(191))'
        );
      }
    } catch (e) {
      console.error('Could not ensure projects per-user name index:', e?.message || e);
    }
  }

  static async nameExistsForUser(userId, projectName) {
    await this.ensureTable();
    const uid = Number(userId);
    const name = String(projectName || '').trim();
    if (!Number.isInteger(uid) || uid <= 0 || !name) return false;
    const [rows] = await db.query(
      `SELECT id FROM projects
       WHERE user_id = ? AND LOWER(TRIM(project_name)) = LOWER(?)
       LIMIT 1`,
      [uid, name]
    );
    return Boolean(rows?.[0]);
  }

  static async create(userId, projectName) {
    await this.ensureTable();
    const uid = Number(userId);
    const name = String(projectName || '').trim();
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('Invalid user id');
      err.statusCode = 400;
      throw err;
    }
    if (!name) {
      const err = new Error('Project name is required');
      err.statusCode = 400;
      throw err;
    }
    if (await this.nameExistsForUser(uid, name)) {
      const err = new Error('A project with this name already exists in your account');
      err.statusCode = 409;
      err.code = 'PROJECT_NAME_EXISTS';
      throw err;
    }
    try {
      const [result] = await db.query(
        'INSERT INTO projects (user_id, project_name) VALUES (?, ?)',
        [uid, name]
      );
      return result.insertId;
    } catch (insertErr) {
      if (insertErr?.code === 'ER_DUP_ENTRY') {
        const err = new Error('A project with this name already exists in your account');
        err.statusCode = 409;
        err.code = 'PROJECT_NAME_EXISTS';
        throw err;
      }
      throw insertErr;
    }
  }

  static async findByUser(userId) {
    await this.ensureTable();
    const [rows] = await db.query(
      `SELECT p.*, u.name as owner_name, u.role as owner_role
       FROM projects p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ? ORDER BY p.created_at DESC`,
      [userId]
    );
    return rows;
  }

  static async findAll() {
    await this.ensureTable();
    // Join with users table (Sequelize User model uses `users`)
    const [rows] = await db.query(
      `SELECT p.*, u.name as owner_name, u.role as owner_role
       FROM projects p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    return rows;
  }

  static async findById(id) {
    await this.ensureTable();
    const [rows] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);
    return rows[0];
  }

  static async delete(id) {
    await this.ensureTable();
    await db.query('DELETE FROM projects WHERE id = ?', [id]);
  }

  static async setHidden(id, hidden) {
    await this.ensureTable();
    const flag = hidden ? 1 : 0;
    await db.query('UPDATE projects SET is_hidden = ? WHERE id = ?', [flag, id]);
  }

  static async ensureUsersWccColumn() {
    try {
      const [cols] = await db.query(`SHOW COLUMNS FROM users LIKE 'wcc_credits'`);
      if (!Array.isArray(cols) || cols.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN wcc_credits BIGINT NOT NULL DEFAULT 0');
      }
    } catch (e) {
      console.error('Could not ensure users.wcc_credits:', e?.message || e);
    }
  }

  /**
   * Move legacy `users.wcc_credits` into this project when the project wallet is empty
   * (purchases made before per-project WCC was enabled).
   */
  static async attachLegacyUserWccToProject(projectId, ownerUserId) {
    const pid = Number(projectId);
    const uid = Number(ownerUserId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(uid) || uid <= 0) {
      return 0;
    }

    await this.ensureTable();
    await this.ensureUsersWccColumn();

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [ownRows] = await conn.query(
        'SELECT user_id, COALESCE(wcc_credits, 0) AS wcc FROM projects WHERE id = ? FOR UPDATE',
        [pid]
      );
      if (!ownRows?.[0] || Number(ownRows[0].user_id) !== uid) {
        await conn.rollback();
        return 0;
      }

      const projectWcc = Number(ownRows[0].wcc) || 0;
      if (projectWcc > 0) {
        await conn.commit();
        return projectWcc;
      }

      const [userRows] = await conn.query(
        'SELECT COALESCE(wcc_credits, 0) AS wcc FROM users WHERE id = ? FOR UPDATE',
        [uid]
      );
      const legacy = Number(userRows?.[0]?.wcc) || 0;
      if (legacy <= 0) {
        await conn.commit();
        return 0;
      }

      await conn.query('UPDATE projects SET wcc_credits = ? WHERE id = ?', [legacy, pid]);
      await conn.query('UPDATE users SET wcc_credits = 0 WHERE id = ?', [uid]);
      await conn.commit();
      return legacy;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /** WCC balance for this project (`projects.wcc_credits`). */
  static async getWccCredits(projectId, ownerUserId) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return 0;

    const uid = Number(ownerUserId);
    if (Number.isInteger(uid) && uid > 0) {
      await this.attachLegacyUserWccToProject(pid, uid);
    }

    const [rows] = await db.query(
      `SELECT COALESCE(wcc_credits, 0) AS wcc FROM projects WHERE id = ? LIMIT 1`,
      [pid]
    );
    if (!rows?.[0]) return 0;
    return roundWccAmount(rows[0].wcc);
  }

  /** Atomically add WCC credits to this project. */
  static async tryIncrementWccCredits(projectId, amount) {
    await this.ensureTable();
    const pid = Number(projectId);
    const add = Math.floor(Number(amount) || 0);
    if (!Number.isInteger(pid) || pid <= 0 || add <= 0) {
      return { ok: false, affected: 0 };
    }
    const [result] = await db.query(
      `UPDATE projects SET wcc_credits = COALESCE(wcc_credits, 0) + ? WHERE id = ?`,
      [add, pid]
    );
    const affected = Number(result?.affectedRows || 0);
    return { ok: affected > 0, affected };
  }

  /** Super-admin adjustment: add/subtract credits or set absolute balance. */
  static async adjustWccCredits(projectId, { mode = 'add', amount = 0 } = {}) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, message: 'Invalid project id' };
    }

    const normalizedMode = String(mode || 'add').trim().toLowerCase();
    const amt = Math.floor(Number(amount) || 0);

    if (normalizedMode === 'set') {
      if (amt < 0) {
        return { ok: false, message: 'Balance cannot be negative' };
      }
      const [result] = await db.query('UPDATE projects SET wcc_credits = ? WHERE id = ?', [amt, pid]);
      if (!Number(result?.affectedRows)) {
        return { ok: false, message: 'Project not found' };
      }
      return { ok: true, balance: amt, previousBalance: null };
    }

    if (amt === 0) {
      return { ok: false, message: 'Adjustment amount is required' };
    }

    if (amt > 0) {
      const inc = await this.tryIncrementWccCredits(pid, amt);
      if (!inc.ok) return { ok: false, message: 'Failed to add credits' };
    } else {
      const dec = await this.tryDecrementWccCredits(pid, null, Math.abs(amt));
      if (!dec.ok) {
        return { ok: false, message: 'Insufficient credits for this adjustment' };
      }
    }

    const [rows] = await db.query(
      'SELECT COALESCE(wcc_credits, 0) AS wcc FROM projects WHERE id = ? LIMIT 1',
      [pid]
    );
    return {
      ok: true,
      balance: Number(rows?.[0]?.wcc) || 0,
      adjustedBy: amt,
    };
  }

  static async getProjectOwnerId(projectId) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const [rows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [pid]);
    if (!rows?.[0]) return null;
    const uid = Number(rows[0].user_id);
    return Number.isInteger(uid) && uid > 0 ? uid : null;
  }

  /** Atomically subtract WCC credits from this project. */
  static async tryDecrementWccCredits(projectId, _ownerUserId, amount) {
    await this.ensureTable();
    const pid = Number(projectId);
    const sub = roundWccAmount(amount);
    if (!Number.isInteger(pid) || pid <= 0 || sub <= 0) {
      return { ok: false, affected: 0 };
    }
    const [result] = await db.query(
      `UPDATE projects
       SET wcc_credits = ROUND(COALESCE(wcc_credits, 0) - ?, 2)
       WHERE id = ? AND ROUND(COALESCE(wcc_credits, 0), 2) >= ?`,
      [sub, pid, sub]
    );
    const affected = Number(result?.affectedRows || 0);
    return { ok: affected > 0, affected };
  }

  /** Pro-rata plan value remaining until renewal. */
  static computePlanRemainingAmount(planAmount, purchasedAt, renewsOn) {
    const amount = Number(planAmount) || 0;
    if (amount <= 0) return 0;
    if (!purchasedAt || !renewsOn) return amount;
    const start = new Date(purchasedAt).getTime();
    const end = new Date(renewsOn).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    const now = Date.now();
    if (now >= end) return 0;
    if (now <= start) return amount;
    const ratio = (end - now) / (end - start);
    return Math.round(amount * ratio * 100) / 100;
  }

  /** Current subscription plan for this project (null if none / expired). */
  static async getPlanInfo(projectId) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const [rows] = await db.query(
      `SELECT plan_slug, plan_cycle, plan_purchased_at, plan_renews_on, plan_active,
              razorpay_payment_id, razorpay_order_id, plan_amount, plan_remaining_amount,
              COALESCE(wcc_credits, 0) AS wcc_credits,
              last_wcc_payment_id, last_wcc_purchase_amount
       FROM projects WHERE id = ? LIMIT 1`,
      [pid]
    );
    const row = rows?.[0];
    if (!row) return null;
    const renewsOn = row.plan_renews_on ? new Date(row.plan_renews_on) : null;
    const purchasedAt = row.plan_purchased_at ? new Date(row.plan_purchased_at) : null;
    const activeFlag = Number(row.plan_active) === 1;
    const notExpired = !renewsOn || renewsOn.getTime() >= Date.now();
    const active = activeFlag && notExpired && Boolean(row.plan_slug);
    const planAmount = row.plan_amount != null ? Number(row.plan_amount) : null;
    const planRemainingAmount = this.computePlanRemainingAmount(
      planAmount,
      purchasedAt,
      renewsOn
    );

    const base = {
      plan: row.plan_slug || null,
      cycle: row.plan_cycle ? String(row.plan_cycle) : null,
      purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
      renewsOn: renewsOn ? renewsOn.toISOString() : null,
      razorpayPaymentId: row.razorpay_payment_id || null,
      razorpayOrderId: row.razorpay_order_id || null,
      planAmount,
      planRemainingAmount,
      wccCredits: Number(row.wcc_credits) || 0,
      lastWccPaymentId: row.last_wcc_payment_id || null,
      lastWccPurchaseAmount:
        row.last_wcc_purchase_amount != null ? Number(row.last_wcc_purchase_amount) : null,
    };

    if (!active) {
      return {
        active: false,
        ...base,
      };
    }

    if (planAmount != null && planRemainingAmount != null) {
      try {
        await db.query('UPDATE projects SET plan_remaining_amount = ? WHERE id = ?', [
          planRemainingAmount,
          pid,
        ]);
      } catch (_) {
        /* non-fatal */
      }
    }

    return {
      active: true,
      plan: String(row.plan_slug),
      ...base,
    };
  }

  /** Activate / update subscription plan for this project. */
  static async setPlanInfo(projectId, { plan, cycle, purchasedAt, renewsOn, active = true }) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false };
    }
    const slug = String(plan || '').trim().toLowerCase().slice(0, 64);
    if (!slug) return { ok: false };
    const cycleVal = String(cycle || '').trim().toLowerCase().slice(0, 32) || null;
    const purchased =
      purchasedAt instanceof Date
        ? purchasedAt
        : purchasedAt
          ? new Date(purchasedAt)
          : new Date();
    const renews =
      renewsOn instanceof Date ? renewsOn : renewsOn ? new Date(renewsOn) : null;
    const [result] = await db.query(
      `UPDATE projects
       SET plan_slug = ?,
           plan_cycle = ?,
           plan_purchased_at = ?,
           plan_renews_on = ?,
           plan_active = ?
       WHERE id = ?`,
      [
        slug,
        cycleVal,
        purchased,
        renews,
        active ? 1 : 0,
        pid,
      ]
    );
    return { ok: Number(result?.affectedRows || 0) > 0 };
  }

  /** Persist Razorpay plan purchase on the project row. */
  static async recordPlanPurchase(
    projectId,
    { paymentId, orderId, amount, plan, cycle, purchasedAt, renewsOn }
  ) {
    await this.ensureTable();
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false };

    const slug = String(plan || '').trim().toLowerCase().slice(0, 64);
    if (!slug) return { ok: false };

    const cycleVal = String(cycle || 'monthly').trim().toLowerCase().slice(0, 32);
    const purchased =
      purchasedAt instanceof Date
        ? purchasedAt
        : purchasedAt
          ? new Date(purchasedAt)
          : new Date();
    const renews =
      renewsOn instanceof Date ? renewsOn : renewsOn ? new Date(renewsOn) : null;
    const planAmount = Math.round((Number(amount) || 0) * 100) / 100;
    const planRemainingAmount = this.computePlanRemainingAmount(planAmount, purchased, renews);

    const [result] = await db.query(
      `UPDATE projects
       SET plan_slug = ?,
           plan_cycle = ?,
           plan_purchased_at = ?,
           plan_renews_on = ?,
           plan_active = 1,
           razorpay_payment_id = ?,
           razorpay_order_id = ?,
           plan_amount = ?,
           plan_remaining_amount = ?
       WHERE id = ?`,
      [
        slug,
        cycleVal,
        purchased,
        renews,
        paymentId ? String(paymentId).slice(0, 64) : null,
        orderId ? String(orderId).slice(0, 64) : null,
        planAmount > 0 ? planAmount : null,
        planRemainingAmount > 0 ? planRemainingAmount : planAmount > 0 ? planAmount : null,
        pid,
      ]
    );
    return { ok: Number(result?.affectedRows || 0) > 0, planAmount, planRemainingAmount };
  }

  /** Persist Razorpay WCC purchase on the project row. */
  static async recordWccPurchase(projectId, { paymentId, orderId, amount, credits }) {
    await this.ensureTable();
    const pid = Number(projectId);
    const creditAdd = Math.floor(Number(credits) || 0);
    const purchaseAmount = Math.round((Number(amount) || 0) * 100) / 100;
    if (!Number.isInteger(pid) || pid <= 0 || creditAdd <= 0) {
      return { ok: false };
    }

    const [result] = await db.query(
      `UPDATE projects
       SET wcc_credits = COALESCE(wcc_credits, 0) + ?,
           last_wcc_payment_id = ?,
           last_wcc_purchase_amount = ?,
           razorpay_payment_id = ?,
           razorpay_order_id = ?
       WHERE id = ?`,
      [
        creditAdd,
        paymentId ? String(paymentId).slice(0, 64) : null,
        purchaseAmount > 0 ? purchaseAmount : null,
        paymentId ? String(paymentId).slice(0, 64) : null,
        orderId ? String(orderId).slice(0, 64) : null,
        pid,
      ]
    );
    return { ok: Number(result?.affectedRows || 0) > 0 };
  }
}

module.exports = Project;

