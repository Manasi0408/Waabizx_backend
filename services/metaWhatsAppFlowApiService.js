const axios = require('axios');
const FormData = require('form-data');
const { WhatsAppAccount } = require('../models');
const { getMetaTokenFromEnv, getWabaIdFromEnv } = require('../utils/metaWhatsAppCredentials');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

async function resolveMetaFlowApiCredentials(userId, projectId) {
  const uid = Number(userId);
  const pid = Number(projectId);

  if (Number.isInteger(uid) && uid > 0 && Number.isInteger(pid) && pid > 0) {
    const account = await WhatsAppAccount.findOne({
      where: { client_id: uid, projectId: pid },
      attributes: ['waba_id', 'access_token'],
      order: [['id', 'DESC']],
    });
    if (account?.waba_id && account?.access_token) {
      return {
        wabaId: String(account.waba_id).trim(),
        accessToken: String(account.access_token).trim(),
        source: 'whatsapp_accounts',
      };
    }
  }

  const envWaba = getWabaIdFromEnv();
  const envToken = getMetaTokenFromEnv();
  if (envWaba && envToken) {
    return { wabaId: envWaba, accessToken: envToken, source: 'env' };
  }

  return null;
}

function formatGraphError(error) {
  const data = error?.response?.data;
  return (
    data?.error?.error_user_msg ||
    data?.error?.message ||
    data?.message ||
    error?.message ||
    'Meta Flow API request failed'
  );
}

async function createMetaWhatsAppFlow({ wabaId, accessToken, name, categories, endpointUri }) {
  const body = { name, categories };
  if (endpointUri) body.endpoint_uri = endpointUri;

  const response = await axios.post(
    `${GRAPH_BASE}/${encodeURIComponent(wabaId)}/flows`,
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    const err = new Error(formatGraphError({ response }));
    err.response = response;
    throw err;
  }

  return response.data;
}

async function updateMetaFlowMetadata({ flowId, accessToken, name, endpointUri, categories }) {
  const body = { name };
  if (endpointUri) body.endpoint_uri = endpointUri;
  if (categories?.length) body.categories = categories;

  const response = await axios.post(`${GRAPH_BASE}/${encodeURIComponent(flowId)}`, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(formatGraphError({ response }));
    err.response = response;
    throw err;
  }

  return response.data;
}

async function uploadMetaFlowJson({ flowId, accessToken, flowJson }) {
  const jsonString = JSON.stringify(flowJson);
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', Buffer.from(jsonString, 'utf8'), {
    filename: 'flow.json',
    contentType: 'application/json',
  });

  const response = await axios.post(
    `${GRAPH_BASE}/${encodeURIComponent(flowId)}/assets`,
    form,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...form.getHeaders(),
      },
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  if (response.status >= 400) {
    const err = new Error(formatGraphError({ response }));
    err.response = response;
    err.validationErrors = response.data?.validation_errors || [];
    throw err;
  }

  return response.data;
}

async function publishMetaFlow({ flowId, accessToken }) {
  const response = await axios.post(
    `${GRAPH_BASE}/${encodeURIComponent(flowId)}/publish`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    const err = new Error(formatGraphError({ response }));
    err.response = response;
    throw err;
  }

  return response.data;
}

function shouldUseMetaFlowEndpoint(req) {
  if (req?.body?.useEndpoint === true) return true;
  if (req?.body?.useEndpoint === false) return false;
  return String(process.env.META_FLOW_USE_ENDPOINT || '').toLowerCase() === 'true';
}

function resolveMetaFlowEndpointUri(req) {
  const configured =
    process.env.META_FLOW_ENDPOINT_URI ||
    process.env.PUBLIC_API_URL ||
    process.env.BACKEND_URL ||
    process.env.API_BASE_URL ||
    '';

  if (configured) {
    const trimmed = String(configured).replace(/\/$/, '');
    return trimmed.endsWith('/api/meta/flow') ? trimmed : `${trimmed}/api/meta/flow`;
  }

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  return `${proto}://${host}/api/meta/flow`;
}

module.exports = {
  resolveMetaFlowApiCredentials,
  resolveMetaFlowEndpointUri,
  shouldUseMetaFlowEndpoint,
  createMetaWhatsAppFlow,
  updateMetaFlowMetadata,
  uploadMetaFlowJson,
  publishMetaFlow,
};
