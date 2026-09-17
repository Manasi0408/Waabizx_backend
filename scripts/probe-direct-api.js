#!/usr/bin/env node
/**
 * Regenerate Direct API JWT + optional send message probe.
 * Logs REQUEST, PAYLOAD, RESPONSE to backend/logs/direct-api.log
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { probeDirectApisOnStartup } = require('../services/aisensyDirectApiClient');

probeDirectApisOnStartup()
  .then((results) => {
    console.log('Direct API probe finished. See backend/logs/direct-api.log');
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Direct API probe failed:', err.message);
    process.exit(1);
  });
