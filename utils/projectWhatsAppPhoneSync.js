const db = require('../config/db');
const { WhatsAppAccount } = require('../models');

/**
 * Keep projects.whatsapp_number_id aligned with the phone actually used for sends/webhooks.
 */
async function syncProjectWhatsAppPhoneId(projectId, phoneNumberId, displayPhone = null) {
  const pid = Number(projectId);
  const phone = String(phoneNumberId || '').trim();
  if (!Number.isInteger(pid) || pid <= 0 || !phone) return false;

  try {
    // One phone_number_id must map to one local project (prevents webhook stealing).
    await db.query(
      `UPDATE projects SET whatsapp_number_id = NULL WHERE whatsapp_number_id = ? AND id != ?`,
      [phone, pid]
    );

    const display = displayPhone != null ? String(displayPhone).trim() : '';
    if (display) {
      await db.query(
        `UPDATE projects
         SET whatsapp_number_id = ?, whatsapp_display_phone = ?
         WHERE id = ?`,
        [phone, display, pid]
      );
    } else {
      await db.query(
        `UPDATE projects SET whatsapp_number_id = ? WHERE id = ?`,
        [phone, pid]
      );
    }
    return true;
  } catch (e) {
    console.warn('[project-phone-sync] syncProjectWhatsAppPhoneId:', e?.message || e);
    return false;
  }
}

/**
 * Resolve local project for inbound webhooks.
 * whatsapp_accounts.projectId is authoritative; projects.whatsapp_number_id is fallback only.
 */
async function resolveProjectFromWebhookPhone({ phoneNumberId, wabaId }) {
  const phone = String(phoneNumberId || '').trim();
  const waba = String(wabaId || '').trim();

  let account = null;

  if (phone) {
    const rows = await WhatsAppAccount.findAll({
      where: { phone_number_id: phone },
      attributes: ['client_id', 'phone_number_id', 'waba_id', 'projectId'],
      order: [['id', 'DESC']],
    });

    if (rows.length === 1) {
      account = rows[0];
    } else if (rows.length > 1) {
      if (waba) {
        account = rows.find((r) => String(r.waba_id || '') === waba) || null;
      }
      if (!account) {
        for (const row of rows) {
          const pid = Number(row.projectId);
          if (!Number.isInteger(pid) || pid <= 0) continue;
          const [matched] = await db.query(
            `SELECT id FROM projects
             WHERE id = ? AND whatsapp_number_id = ?
             LIMIT 1`,
            [pid, phone]
          );
          if (Array.isArray(matched) && matched.length > 0) {
            account = row;
            break;
          }
        }
      }
      if (!account) account = rows[0];
    }
  }

  if (!account && waba) {
    account = await WhatsAppAccount.findOne({
      where: { waba_id: waba },
      attributes: ['client_id', 'phone_number_id', 'waba_id', 'projectId'],
      order: [['id', 'DESC']],
    });
  }

  if (account?.projectId && Number(account.projectId) > 0) {
    return {
      projectId: Number(account.projectId),
      clientUserId: account.client_id ? Number(account.client_id) : null,
      account,
    };
  }

  if (phone) {
    const [projects] = await db.query(
      'SELECT id FROM projects WHERE whatsapp_number_id = ? ORDER BY id DESC LIMIT 1',
      [phone]
    );
    if (Array.isArray(projects) && projects.length > 0) {
      return {
        projectId: Number(projects[0].id),
        clientUserId: null,
        account: null,
      };
    }
  }

  return { projectId: null, clientUserId: null, account: null };
}

function extractInboundPhoneNumberId(payload, valueEntry = null) {
  const fromValue = valueEntry?.metadata?.phone_number_id;
  const fromPayload =
    payload?.phone_number_id ||
    payload?.metadata?.phone_number_id ||
    payload?.message?.phone_number_id ||
    payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  const phone = String(fromValue || fromPayload || '').trim();
  return phone || null;
}

async function resolveInboundFlowProjectId({ phoneNumberId, wabaId, fallbackProjectId = null }) {
  if (!phoneNumberId) return fallbackProjectId || null;
  const mapped = await resolveProjectFromWebhookPhone({ phoneNumberId, wabaId });
  if (mapped.projectId) {
    syncProjectWhatsAppPhoneId(mapped.projectId, phoneNumberId).catch(() => {});
    return mapped.projectId;
  }
  return fallbackProjectId || null;
}

module.exports = {
  syncProjectWhatsAppPhoneId,
  resolveProjectFromWebhookPhone,
  extractInboundPhoneNumberId,
  resolveInboundFlowProjectId,
};
