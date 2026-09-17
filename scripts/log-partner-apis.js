#!/usr/bin/env node
/**
 * Run all 3 AiSensy Partner APIs and write logs to backend/logs/partner-api.log
 * Hostinger cron example (every 6 hours):
 *   0 0,6,12,18 * * * cd /path/to/backend && node scripts/log-partner-apis.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { probePartnerApisOnStartup } = require('../services/aisensyPartnerApiClient');

probePartnerApisOnStartup()
  .then((results) => {
    console.log('Partner API probe finished. See backend/logs/partner-api.log');
    console.log(JSON.stringify(results?.apis || results, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Partner API probe failed:', err.message);
    process.exit(1);
  });
