const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_NAMES = {
  app: 'app.log',
  error: 'error.log',
  apiFailures: 'api-failures.log',
  aisensyBilling: 'aisensy-billing.log',
  metaOnboarding: 'meta-onboarding.log',
  onboarding: 'onboarding.log',
  embeddedSignup: 'embedded-signup.log',
  directApi: 'direct-api.log',
  partnerApi: 'partner-api.log',
  flowMessages: 'flow-messages.log',
  whatsappSend: 'whatsapp-send.log',
  webhook: 'webhook.log',
};

/** Folder name for today, e.g. logs/2026-09-01/ */
function getDateFolderName(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDailyLogsDir(date = new Date()) {
  const dayDir = path.join(logsDir, getDateFolderName(date));
  if (!fs.existsSync(dayDir)) {
    fs.mkdirSync(dayDir, { recursive: true });
  }
  return dayDir;
}

function getDailyLogPath(fileName, date = new Date()) {
  return path.join(getDailyLogsDir(date), fileName);
}

function buildLogPaths() {
  const dateFolder = getDateFolderName();
  const dateDir = getDailyLogsDir();
  return {
    dateFolder,
    dateDir,
    root: logsDir,
    app: getDailyLogPath(LOG_NAMES.app),
    error: getDailyLogPath(LOG_NAMES.error),
    apiFailures: getDailyLogPath(LOG_NAMES.apiFailures),
    aisensyBilling: getDailyLogPath(LOG_NAMES.aisensyBilling),
    metaOnboarding: getDailyLogPath(LOG_NAMES.metaOnboarding),
    onboarding: getDailyLogPath(LOG_NAMES.onboarding),
    embeddedSignup: getDailyLogPath(LOG_NAMES.embeddedSignup),
    directApi: getDailyLogPath(LOG_NAMES.directApi),
    partnerApi: getDailyLogPath(LOG_NAMES.partnerApi),
    flowMessages: getDailyLogPath(LOG_NAMES.flowMessages),
    whatsappSend: getDailyLogPath(LOG_NAMES.whatsappSend),
    webhook: getDailyLogPath(LOG_NAMES.webhook),
  };
}

const getTimestamp = () => new Date().toISOString();

const writeToFile = (filePath, message) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, `${message}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to write to log file:', error.message);
  }
};

function writeToDailyLog(logKey, message) {
  const fileName = LOG_NAMES[logKey] || logKey;
  writeToFile(getDailyLogPath(fileName), message);
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_) {
    return JSON.stringify(String(value));
  }
}

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'secret',
  'api_key',
  'apiKey',
  'direct_api_password_enc',
  'direct_api_jwt',
  'jwt',
  'otp',
  'code',
]);

function sanitizeLogData(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogData(item, depth + 1));
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(lower)) {
      out[key] = '***';
      continue;
    }
    if (lower.includes('password') || lower.includes('secret') || lower.includes('token')) {
      out[key] = '***';
      continue;
    }
    out[key] = sanitizeLogData(raw, depth + 1);
  }
  return out;
}

function isFailedApiResponse(response) {
  if (response == null) return false;
  if (typeof response === 'object') {
    if (Number(response.status) >= 400) return true;
    if (response.ok === false) return true;
    if (response.success === false) return true;
    if (response.error) return true;
    if (response.skipped) return false;
  }
  const op = String(response?.operation || '');
  if (/_ERROR$|_NETWORK_ERROR$/i.test(op)) return true;
  return false;
}

function printErrorLine(line) {
  console.error(line);
}

function printLine(line) {
  console.log(line);
}

/** PAYLOAD + RESPONSE pair → dedicated log file + console */
function writePayloadResponse(operation, payload, response, logKey) {
  const ts = getTimestamp();
  const op = String(operation || 'API').trim();
  const payloadLine = `[${ts}] [${op}] PAYLOAD: ${safeJson(payload)}`;
  const responseLine = `[${ts}] [${op}] RESPONSE: ${safeJson(response)}`;
  printLine(payloadLine);
  printLine(responseLine);
  writeToDailyLog(logKey, payloadLine);
  writeToDailyLog(logKey, responseLine);
}

/** REQUEST + PAYLOAD + RESPONSE → dedicated log file + console */
function writeRequestPayloadResponse(operation, request, payload, response, logKey, options = {}) {
  const ts = getTimestamp();
  const op = String(operation || 'API').trim();
  const requestLine = `[${ts}] [${op}] REQUEST: ${safeJson(request)}`;
  const payloadLine = `[${ts}] [${op}] PAYLOAD: ${safeJson(payload)}`;
  const responseLine = `[${ts}] [${op}] RESPONSE: ${safeJson(response)}`;
  printLine(requestLine);
  printLine(payloadLine);
  printLine(responseLine);
  writeToDailyLog(logKey, requestLine);
  writeToDailyLog(logKey, payloadLine);
  writeToDailyLog(logKey, responseLine);

  if (!options.skipApiFailureLog && isFailedApiResponse(response)) {
    logApiFailure({
      direction: 'outbound',
      operation: op,
      request: sanitizeLogData(request),
      payload: sanitizeLogData(payload),
      response: sanitizeLogData(response),
    });
  }
}

/** AiSensy / Meta partner billing — aisensy-billing.log + console */
function aisensyBillingPayloadResponse(operation, payload, response) {
  writePayloadResponse(operation, payload, response, 'aisensyBilling');
}

/** Meta OAuth callback / onboard — meta-onboarding.log + console */
function metaCallbackPayloadResponse(operation, payload, response) {
  writePayloadResponse(operation, payload, response, 'metaOnboarding');
}

/** WhatsApp connect onboarding (business + project + signup URL) — onboarding.log + console */
function onboardingPayloadResponse(operation, payload, response) {
  writePayloadResponse(operation, payload, response, 'onboarding');
}

/** Embedded Signup full trail — REQUEST + PAYLOAD + RESPONSE → embedded-signup.log (+ mirror meta-onboarding) */
function embeddedSignupPayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'embeddedSignup');
  writeRequestPayloadResponse(operation, request, payload, response, 'metaOnboarding', {
    skipApiFailureLog: true,
  });
}

/** Direct API — REQUEST + PAYLOAD + RESPONSE in direct-api.log + console */
function directApiPayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'directApi');
}

/** AiSensy Partner API — REQUEST + PAYLOAD + RESPONSE in partner-api.log + direct-api.log + console */
function partnerApiPayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'partnerApi');
  writeRequestPayloadResponse(operation, request, payload, response, 'directApi', {
    skipApiFailureLog: true,
  });
}

/** Flow / chatbot WhatsApp sends — flow-messages.log + direct-api.log + console */
function flowMessagePayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'flowMessages');
  writeRequestPayloadResponse(operation, request, payload, response, 'directApi', {
    skipApiFailureLog: true,
  });
}

/** Every outbound WhatsApp message send — whatsapp-send.log + direct-api.log + console */
function whatsappSendPayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'whatsappSend');
  writeRequestPayloadResponse(operation, request, payload, response, 'directApi', {
    skipApiFailureLog: true,
  });
}

/** Inbound WhatsApp webhooks — webhook.log + console */
function webhookPayloadResponse(operation, request, payload, response) {
  writeRequestPayloadResponse(operation, request, payload, response, 'webhook');
}

function writeLog(message) {
  const line = `[${getTimestamp()}] ${message}`;
  printLine(line);
  writeToDailyLog('app', line);
}

function writeLogBoth(message, data = null) {
  writeLog(message);
  if (data != null) {
    const dataLine = `[${getTimestamp()}] ${JSON.stringify(data)}`;
    printLine(dataLine);
    writeToDailyLog('app', dataLine);
  }
}

function announceLogPaths() {
  const paths = buildLogPaths();
  writeLog('Server log files ready (daily folders under backend/logs/):');
  writeLog(`  date folder          → ${paths.dateDir}`);
  writeLog(`  app.log              → ${paths.app}`);
  writeLog(`  error.log            → ${paths.error}`);
  writeLog(`  api-failures.log     → ${paths.apiFailures}`);
  writeLog(`  aisensy-billing.log  → ${paths.aisensyBilling}`);
  writeLog(`  meta-onboarding.log  → ${paths.metaOnboarding}`);
  writeLog(`  onboarding.log       → ${paths.onboarding}`);
  writeLog(`  embedded-signup.log  → ${paths.embeddedSignup}`);
  writeLog(`  direct-api.log       → ${paths.directApi}`);
  writeLog(`  partner-api.log      → ${paths.partnerApi}`);
  writeLog(`  flow-messages.log    → ${paths.flowMessages}`);
  writeLog(`  whatsapp-send.log    → ${paths.whatsappSend}`);
  writeLog(`  webhook.log          → ${paths.webhook}`);
}

/**
 * Log failed API calls to backend/logs/YYYY-MM-DD/api-failures.log and terminal.
 */
function logApiFailure(entry = {}) {
  const ts = getTimestamp();
  const direction = String(entry.direction || 'unknown').toUpperCase();
  const method = entry.method ? String(entry.method).toUpperCase() : '';
  const pathOrUrl = entry.path || entry.url || entry.operation || '';
  const status = entry.status != null ? Number(entry.status) : null;
  const durationMs = entry.durationMs != null ? Number(entry.durationMs) : null;
  const parts = [`[${ts}]`, `[${direction}]`];

  if (method) parts.push(method);
  if (pathOrUrl) parts.push(String(pathOrUrl));
  if (status) parts.push(String(status));
  if (durationMs != null && !Number.isNaN(durationMs)) parts.push(`${durationMs}ms`);

  const meta = sanitizeLogData({
    message: entry.message || null,
    operation: entry.operation || null,
    userId: entry.userId ?? null,
    projectId: entry.projectId ?? null,
    ip: entry.ip || null,
    request: entry.request ?? null,
    payload: entry.payload ?? null,
    response: entry.response ?? null,
    error: entry.error
      ? {
          message: entry.error?.message || String(entry.error),
          code: entry.error?.code || entry.error?.statusCode || null,
          stack: entry.error?.stack || null,
        }
      : null,
  });

  const line = `${parts.join(' ')} | ${safeJson(meta)}`;
  printErrorLine(line);
  writeToDailyLog('apiFailures', line);
}

const logger = {
  get logPaths() {
    return buildLogPaths();
  },

  writeLog,
  writeLogBoth,
  logApiFailure,
  sanitizeLogData,
  flowMessagePayloadResponse,
  whatsappSendPayloadResponse,
  webhookPayloadResponse,
  aisensyBillingPayloadResponse,
  metaCallbackPayloadResponse,
  onboardingPayloadResponse,
  embeddedSignupPayloadResponse,
  directApiPayloadResponse,
  partnerApiPayloadResponse,
  announceLogPaths,
  getDateFolderName,
  getDailyLogsDir,
  getDailyLogPath,
  buildLogPaths,

  log: (message, data = null) => {
    writeLogBoth(message, data);
  },

  error: (message, error = null) => {
    const errorMessage = `[${getTimestamp()}] ERROR: ${message}`;
    console.error(errorMessage);
    writeToDailyLog('error', errorMessage);
    if (error) {
      const details = error.stack || JSON.stringify(error, null, 2);
      console.error(details);
      writeToDailyLog('error', `Error details: ${details}`);
    }
  },

  metaOnboarding: (step, details = {}) => {
    const msg = `[${getTimestamp()}] [Meta onboarding] ${step} ${safeJson(details)}`;
    printLine(msg);
    writeToDailyLog('metaOnboarding', msg);
  },

  onboarding: (step, details = {}) => {
    const msg = `[${getTimestamp()}] [Onboarding] ${step} ${safeJson(sanitizeLogData(details))}`;
    printLine(msg);
    writeToDailyLog('onboarding', msg);
  },

  requestBody: (req) => {
    try {
      const message = `[${getTimestamp()}] REQUEST BODY - ${req.method} ${req.path || req.url}`;
      printLine(message);
      writeToDailyLog('app', message);
      const bodyLine = `BODY: ${safeJson(req.body || {})}`;
      printLine(bodyLine);
      writeToDailyLog('app', bodyLine);
    } catch (error) {
      console.error('Logger requestBody error:', error.message);
    }
  },
};

module.exports = logger;
module.exports.writeLog = writeLog;
module.exports.writeLogBoth = writeLogBoth;
module.exports.logApiFailure = logApiFailure;
module.exports.sanitizeLogData = sanitizeLogData;
module.exports.aisensyBillingPayloadResponse = aisensyBillingPayloadResponse;
module.exports.metaCallbackPayloadResponse = metaCallbackPayloadResponse;
module.exports.onboardingPayloadResponse = onboardingPayloadResponse;
module.exports.embeddedSignupPayloadResponse = embeddedSignupPayloadResponse;
module.exports.directApiPayloadResponse = directApiPayloadResponse;
module.exports.partnerApiPayloadResponse = partnerApiPayloadResponse;
module.exports.flowMessagePayloadResponse = flowMessagePayloadResponse;
module.exports.whatsappSendPayloadResponse = whatsappSendPayloadResponse;
module.exports.webhookPayloadResponse = webhookPayloadResponse;
module.exports.announceLogPaths = announceLogPaths;
module.exports.getDateFolderName = getDateFolderName;
module.exports.getDailyLogsDir = getDailyLogsDir;
module.exports.getDailyLogPath = getDailyLogPath;
module.exports.buildLogPaths = buildLogPaths;
Object.defineProperty(module.exports, 'logPaths', {
  enumerable: true,
  get: buildLogPaths,
});
