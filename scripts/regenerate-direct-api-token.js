#!/usr/bin/env node
/**
 * Call AiSensy Direct API regenerate JWT endpoint (per docs):
 * POST https://backend.aisensy.com/direct-apis/t1/users/regenrate-token
 * Authorization: Bearer BASE64(email:password:projectId)
 * Body: { "direct_api": true }
 *
 * Logs REQUEST, PAYLOAD, RESPONSE → backend/logs/direct-api.log
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  regenerateTokenDirectApi,
  getOfficialDirectApiBase,
  getPrimaryDirectApiBase,
} = require('../services/aisensyDirectApiClient');

const base = process.argv[2] || getPrimaryDirectApiBase() || getOfficialDirectApiBase();

regenerateTokenDirectApi({ base })
  .then((result) => {
    console.log('Regenerate token OK');
    console.log('Base:', result.base);
    console.log('Status:', result.status);
    console.log('Token preview:', result.token ? `${result.token.slice(0, 16)}...` : '(none)');
    console.log('Full logs: backend/logs/direct-api.log');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Regenerate token failed:', err.message);
    console.error('See backend/logs/direct-api.log for REQUEST / PAYLOAD / RESPONSE');
    process.exit(1);
  });
