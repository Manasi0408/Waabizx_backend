const axios = require('axios');
const { ClientWhatsApp } = require('../models');
const { resolveWabaAndPhoneFromToken } = require('../services/meta.service');

const APP_ID = process.env.APP_ID || process.env.META_APP_ID;
const APP_SECRET =
  process.env.APP_SECRET || process.env.META_APP_SECRET || process.env.META_APPSECRET;
const API_VERSION = 'v19.0';

async function exchangeCode(code) {
  const response = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token`,
    {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code,
      },
    }
  );
  return response.data.access_token;
}

async function getLongLivedToken(shortToken) {
  const response = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token`,
    {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: APP_ID,
        client_secret: APP_SECRET,
        fb_exchange_token: shortToken,
      },
    }
  );
  return response.data.access_token;
}

exports.onboard = async (req, res) => {
  try {
    const { code, client_id: clientId } = req.body;

    if (!code || !clientId) {
      return res.status(400).json({
        success: false,
        message: 'Missing code or client_id',
      });
    }

    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({
        success: false,
        message: 'Server misconfiguration: APP_ID or APP_SECRET not set',
      });
    }

    const shortToken = await exchangeCode(code);
    console.log('[Meta onboard legacy] short_lived_token', {
      received: Boolean(shortToken && String(shortToken).length > 0),
      length: shortToken ? String(shortToken).length : 0,
    });
    const longLivedToken = await getLongLivedToken(shortToken);
    console.log('[Meta onboard legacy] long_lived_token', {
      received: Boolean(longLivedToken && String(longLivedToken).length > 0),
      length: longLivedToken ? String(longLivedToken).length : 0,
    });
    const { wabaId, phoneNumberId } = await resolveWabaAndPhoneFromToken(longLivedToken);
    console.log('[Meta onboard legacy] waba_resolved', { wabaId, phoneNumberId, clientId });

    const [row] = await ClientWhatsApp.findOrCreate({
      where: { client_id: clientId },
      defaults: { waba_id: wabaId, phone_number_id: phoneNumberId, access_token: longLivedToken },
    });
    const wasNewRecord = Boolean(row.isNewRecord);
    if (!row.isNewRecord) {
      await row.update({ waba_id: wabaId, phone_number_id: phoneNumberId, access_token: longLivedToken });
    }
    console.log('[Meta onboard legacy] clients_whatsapp_row', {
      rowId: row.id,
      clientId,
      isNewRecord: wasNewRecord,
      tokenSaved: Boolean(longLivedToken && String(longLivedToken).length > 0),
      tokenLength: longLivedToken ? String(longLivedToken).length : 0,
    });

    return res.status(200).json({
      success: true,
      message: 'Onboarding complete',
      data: {
        client_id: clientId,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
      },
    });
  } catch (error) {
    console.error('Meta onboard error:', error.response?.data || error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Onboarding failed';
    return res.status(status).json({
      success: false,
      message: typeof message === 'string' ? message : 'Onboarding failed',
    });
  }
};
