const jwt = require('jsonwebtoken');
const axios = require('axios');
const { sequelize, User, PasswordResetToken } = require('../models');
const db = require('../config/db');
const Setting = require('../models/Setting');
const logger = require('../utils/logger');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const sendOTPEmail = require('../utils/sendEmail');
const {
  resolveRegistrationOtpCredentials,
  ensureCredentialReadyForMessaging,
  filterValidCredentialCandidates,
  formatMetaApiErrorMessage,
  getWabaIdFromEnv,
  getPhoneNumberIdFromEnv,
} = require('../utils/metaWhatsAppCredentials');
const { requireProjectId } = require('../utils/projectScope');
const Project = require('../models/Project');
const { enforcePlanLimit } = require('../services/planLimitService');
const { getWhatsAppPaymentState } = require('../utils/whatsappPayment');
const { resolvePricingContextFromRequest, normalizeCountryCode, getClientIp } = require('../utils/geoCountry');
const { ensureUsersCurrentSessionIdColumn } = require('../utils/ensureUserSessionSchema');
const { issueUserSession } = require('../utils/userSessionStore');

const looksLikeBcryptHash = (value) => {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
};

const generateToken = (id, sessionId) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }
  return jwt.sign({ id, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d'
  });
};

/** Base64 avatars need LONGTEXT; older DBs used VARCHAR(255) and truncated saves. */
let usersAvatarColumnEnsured = false;
async function ensureUsersAvatarLongText() {
  if (usersAvatarColumnEnsured) return;
  usersAvatarColumnEnsured = true;
  try {
    const [rows] = await sequelize.query("SHOW COLUMNS FROM users WHERE Field = 'avatar'");
    if (!rows?.length) return;
    const t = String(rows[0].Type || '').toLowerCase();
    if (!t.includes('longtext')) {
      await sequelize.query('ALTER TABLE users MODIFY COLUMN avatar LONGTEXT NULL');
    }
  } catch (e) {
    console.warn('[auth] ensureUsersAvatarLongText:', e?.message || e);
  }
}

let usersIpColumnEnsured = false;
async function ensureUsersIpColumn() {
  if (usersIpColumnEnsured) return;
  usersIpColumnEnsured = true;
  try {
    const [rows] = await sequelize.query("SHOW COLUMNS FROM users WHERE Field = 'ip'");
    if (!rows?.length) {
      await sequelize.query('ALTER TABLE users ADD COLUMN ip VARCHAR(45) NULL DEFAULT NULL');
    }
  } catch (e) {
    console.warn('[auth] ensureUsersIpColumn:', e?.message || e);
  }
}

function resolveRequestIp(req) {
  const ip = getClientIp(req);
  return ip ? String(ip).trim().slice(0, 45) : null;
}

const pendingRegisterOtps = new Map();
const REGISTRATION_OTP_VALIDITY_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_RESET_OTP_VALIDITY_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_RESET_OTP_HASH_SALT = process.env.PASSWORD_RESET_OTP_SALT || process.env.JWT_SECRET || 'password-reset-otp-salt';

const normalizeMobileNumber = (value) => {
  return String(value || '').replace(/\D/g, '').trim();
};

const parseProjectIdFromRequest = (req) => {
  const raw = req?.projectId ?? req?.headers?.['x-project-id'] ?? req?.body?.projectId;
  const projectId = Number(raw);
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
};

const MANAGER_PERMISSION_KEYS = [
  'campaign',
  'broadcast',
  'template',
  'analytics',
  'flows',
  'contacts',
  'inbox',
  'reports',
  'manage',
  'myProjects',
];

const emptyManagerPermissions = () =>
  MANAGER_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {});

const normalizeManagerPermissions = (value) => {
  const normalized = emptyManagerPermissions();

  if (Array.isArray(value)) {
    value.forEach((key) => {
      const normalizedKey = String(key || '').trim();
      if (normalizedKey && Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) {
        normalized[normalizedKey] = true;
      }
    });
    return normalized;
  }

  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch (_) {
      candidate = null;
    }
  }

  if (!candidate || typeof candidate !== 'object') {
    return normalized;
  }

  MANAGER_PERMISSION_KEYS.forEach((key) => {
    normalized[key] = Boolean(candidate[key]);
  });

  return normalized;
};

const getPermissionsForRole = (role, value) => {
  return role === 'manager' ? normalizeManagerPermissions(value) : null;
};

const createOtpCode = () => String(Math.floor(100000 + Math.random() * 900000));

const hashPasswordResetOtp = (otp) => {
  return crypto
    .createHmac('sha256', PASSWORD_RESET_OTP_HASH_SALT)
    .update(String(otp))
    .digest('hex');
};

const isSmtpConfigured = () => {
  const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM;
  return Boolean(smtpHost && smtpUser && smtpPass && fromAddress);
};

const OTP_EMAIL_PURPOSE = {
  password_reset: {
    subject: 'Your Waabizx password reset OTP',
    buildText: (otp) =>
      `Your password reset OTP is: ${otp}\n\nIt will expire in 10 minutes.\n\nIf you did not request this, ignore this email.`,
  },
  registration: {
    subject: 'Your Waabizx registration OTP',
    buildText: (otp) =>
      `Your registration OTP is: ${otp}\n\nIt will expire in 10 minutes.\n\nEnter this code on the verification page to complete signup.`,
  },
};

const sendOtpToEmail = async (email, otp, purpose = 'password_reset') => {
  const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const fromAddress = process.env.SMTP_FROM || process.env.EMAIL_FROM;

  if (!isSmtpConfigured()) {
    throw new Error('Email transport is not configured.');
  }

  const mailPurpose = OTP_EMAIL_PURPOSE[purpose] || OTP_EMAIL_PURPOSE.password_reset;

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: fromAddress,
    to: email,
    subject: mailPurpose.subject,
    text: mailPurpose.buildText(otp),
  });
};

const getMetaPhoneNumberId = () =>
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.PHONE_NUMBER_ID ||
  process.env.WA_PHONE_NUMBER_ID ||
  process.env.Phone_Number_ID;

const getMetaWabaId = () =>
  process.env.WABA_ID ||
  process.env.WHATSAPP_WABA_ID ||
  process.env.WABAID;

const getMetaAccessToken = () =>
  process.env.WHATSAPP_TOKEN ||
  process.env.PERMANENT_TOKEN ||
  process.env.WA_ACCESS_TOKEN ||
  process.env.Whatsapp_Token;

const getMetaApiVersion = () => process.env.WHATSAPP_API_VERSION || 'v22.0';

const isAuthOtpTemplateName = (name) => {
  const n = String(name || '').toLowerCase();
  return n.includes('auth') || n.includes('otp') || n.includes('verify') || n.includes('code');
};

const buildRegistrationOtpTemplatePayloads = (to, templateName, languageCode, otpCode, category = '') => {
  const phone = to.toString().trim().replace(/^\+/, '');
  const otp = String(otpCode);
  const cat = String(category || '').toUpperCase();
  const isAuth = cat === 'AUTHENTICATION' || isAuthOtpTemplateName(templateName);

  const makePayload = (components) => ({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components?.length ? { components } : {}),
    },
  });

  const payloads = [];
  const seen = new Set();
  const add = (components) => {
    const key = JSON.stringify(components);
    if (seen.has(key)) return;
    seen.add(key);
    payloads.push(makePayload(components));
  };

  if (isAuth) {
    add([
      { type: 'body', parameters: [{ type: 'text', text: otp }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
    ]);
    add([
      { type: 'body', parameters: [{ type: 'text', text: otp }] },
      { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: otp }] },
    ]);
    add([
      { type: 'BODY', parameters: [{ type: 'text', text: otp }] },
      { type: 'BUTTON', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
    ]);
  }

  add([{ type: 'body', parameters: [{ type: 'text', text: otp }] }]);
  add([{ type: 'BODY', parameters: [{ type: 'text', text: otp }] }]);

  return payloads;
};

const sendOtpToWhatsApp = async (mobileNumber, otpCode) => {
  const whatsappPhone = `91${mobileNumber}`;
  const otpMessage = `Your Waabizx registration code is ${otpCode}. It is valid for 10 minutes. Do not share this code.`;

  const allCandidates = await resolveRegistrationOtpCredentials();
  const validCandidates = await filterValidCredentialCandidates(
    (allCandidates || []).filter((c) => c?.phoneNumberId && c?.accessToken),
    2
  );

  if (!validCandidates.length) {
    const envPhone = getPhoneNumberIdFromEnv() || 'your Phone_Number_ID';
    const envWaba = getWabaIdFromEnv() || 'your WABA_ID';
    throw new Error(
      `WhatsApp access token is invalid or expired for phone ${envPhone}. ` +
        `Fix: log in as admin → Connect WhatsApp in the app, OR update WHATSAPP_TOKEN for WABA ${envWaba}, then restart the backend.`
    );
  }

  const attempts = [];
  const seenAttemptMessages = new Set();

  for (const creds of validCandidates) {
    const readiness = await ensureCredentialReadyForMessaging(creds);
    if (!readiness.ready) {
      const msg = readiness.reason || 'WhatsApp not ready for messaging';
      if (!seenAttemptMessages.has(msg)) {
        seenAttemptMessages.add(msg);
        attempts.push(msg);
      }
      continue;
    }

    try {
      await sendText(whatsappPhone, otpMessage, creds);
      return { provider: 'meta-text', source: creds.source };
    } catch (err) {
      const formatted = `${creds.source}: ${formatMetaApiErrorMessage(err)}`;
      if (!seenAttemptMessages.has(formatted)) {
        seenAttemptMessages.add(formatted);
        attempts.push(formatted);
      }
    }
  }

  throw new Error(
    attempts[0] ||
      'Failed to send OTP on WhatsApp. Set META_WHATSAPP_REGISTRATION_PIN in server .env or complete Cloud API registration in the app.'
  );
};

const isUnknownMobileNumberColumnError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('unknown column') && msg.includes('mobilenumber');
};

exports.register = async (req, res) => {
  try {
    // Get body - handle both direct and nested
    let body = req.body;
    
    // If body is empty or null, try to get from different sources
    if (!body || Object.keys(body).length === 0) {
      body = req.body || {};
    }
    
    // Extract fields - be very forgiving
    const name = body.name || body.Name || body.NAME || '';
    const email = body.email || body.Email || body.EMAIL || '';
    const password = body.password || body.Password || body.PASSWORD || '';
    const mobileNumberRaw = body.mobileNumber || body.mobile || body.whatsappNumber || '';
    const roleRaw = body.role || body.Role || body.ROLE || '';
    const requestedRole = String(roleRaw).toLowerCase().trim();
    // New self-service signups default to admin; ManagePage may also pass agent/admin/manager explicitly.
    const normalizedRole = ['agent', 'admin', 'manager'].includes(requestedRole) ? requestedRole : 'admin';
    const normalizedPermissions = getPermissionsForRole(
      normalizedRole,
      body.permissions ?? body.Permissions ?? body.permission ?? body.PERMISSION
    );

    // Simple validation - only check if truly missing
    if (!name || String(name).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }
    
    if (!email || String(email).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }
    
    if (!password || String(password).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }
    
    // Trim and normalize
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim();
    const trimmedPassword = String(password).trim();
    const mobileNumber = normalizeMobileNumber(mobileNumberRaw);

    // Simple email validation - just check for @
    if (!trimmedEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    // Simple password validation - minimum 4 characters
    if (trimmedPassword.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 4 characters long'
      });
    }

    if (mobileNumberRaw && String(mobileNumberRaw).trim() !== '' && !/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid 10-digit mobile number without country code',
      });
    }

    // Check if user already exists
    let userExists;
    try {
      userExists = await User.findOne({ where: { email: trimmedEmail } });
    } catch (dbError) {
      logger.error('Database query error in register', dbError);
      
      // Check if it's a connection error
      if (dbError.original && dbError.original.code === 'ER_ACCESS_DENIED_ERROR') {
        return res.status(500).json({
          success: false,
          message: 'Database connection failed. Please check your MySQL password in .env file.',
          hint: 'Run: npm run test-password to find correct password'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Database error. Please check if database is running and password is correct.',
        error: process.env.NODE_ENV === 'development' ? dbError.message : undefined
      });
    }
    
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    if (mobileNumber) {
      try {
        const existingByMobile = await User.findOne({ where: { mobileNumber } });
        if (existingByMobile) {
          return res.status(400).json({
            success: false,
            message: 'User already exists with this mobile number',
          });
        }
      } catch (mobileCheckError) {
        if (!isUnknownMobileNumberColumnError(mobileCheckError)) {
          throw mobileCheckError;
        }
      }
    }

    // Create user (hash password explicitly to guarantee bcrypt storage)
    let user;
    try {
      await ensureUsersIpColumn();
      const clientIp = resolveRequestIp(req);
      if (['agent', 'manager', 'admin'].includes(normalizedRole)) {
        const registerProjectId = parseProjectIdFromRequest(req);
        const limitCheck = await enforcePlanLimit(req, res, 'agents', {
          projectId: registerProjectId,
        });
        if (limitCheck && !limitCheck.allowed) return;
        if (
          limitCheck?.skipped &&
          ['agent', 'manager'].includes(normalizedRole)
        ) {
          return res.status(400).json({
            success: false,
            message: 'Project is required to add team members. Select a project and try again.',
          });
        }
      }

      const passwordToStore = looksLikeBcryptHash(trimmedPassword)
        ? trimmedPassword
        : await bcrypt.hash(trimmedPassword, 10);

      const userPayload = {
        name: trimmedName,
        email: trimmedEmail,
        password: passwordToStore,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(trimmedName)}&background=random`,
        role: normalizedRole,
        permissions: normalizedPermissions,
        projectId: parseProjectIdFromRequest(req),
      };
      if (mobileNumber) {
        userPayload.mobileNumber = mobileNumber;
      }

      const pricing = await resolvePricingContextFromRequest(req, { mobileNumber });
      userPayload.country = pricing.country;
      userPayload.currency = pricing.currency;
      if (clientIp) userPayload.ip = clientIp;

      user = await User.create(userPayload);

      const registerProjectId = parseProjectIdFromRequest(req);
      const registerProjectIds = Array.isArray(body.projectIds)
        ? body.projectIds
        : registerProjectId
          ? [registerProjectId]
          : [];
      if (['agent', 'manager'].includes(normalizedRole) && registerProjectIds.length > 0) {
        const { setAgentProjects } = require('../services/agentProjectService');
        const assignedBy = req.user?.id || null;
        await setAgentProjects(user.id, registerProjectIds, assignedBy);
      }
    } catch (createError) {
      logger.error('User creation error', createError);
      throw createError;
    }

    // Single-session: create a session id on register + issue token tied to it
    await ensureUsersCurrentSessionIdColumn();
    const sessionId = await issueUserSession(user.id);
    const token = generateToken(user.id, sessionId);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        permissions: user.permissions
      }
    });
  } catch (error) {
    // Handle Sequelize validation errors
    if (error.name === 'SequelizeValidationError') {
      const errors = error.errors.map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }

    // Handle Sequelize unique constraint errors
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // Log the error for debugging
    logger.error('Register Error', error);
    
    // Generic error
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

exports.requestRegisterOtp = async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name || body.Name || '';
    const email = body.email || body.Email || '';
    const password = body.password || body.Password || '';
    const mobileNumberRaw = body.mobileNumber || body.mobile || body.whatsappNumber || '';
    const country = normalizeCountryCode(body.country || body.Country || '');
    const countryCodeRaw = String(body.countryCode || body.country_code || '').trim();

    if (!name || String(name).trim() === '') {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email || String(email).trim() === '') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!password || String(password).trim() === '') {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }
    if (!country) {
      return res.status(400).json({ success: false, message: 'Country is required' });
    }
    if (!countryCodeRaw) {
      return res.status(400).json({ success: false, message: 'Country code is required' });
    }
    if (!mobileNumberRaw || String(mobileNumberRaw).trim() === '') {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }

    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim();
    const trimmedPassword = String(password).trim();
    // Self-service OTP registration always creates an account owner (admin).
    const normalizedRole = 'admin';
    const mobileNumber = normalizeMobileNumber(mobileNumberRaw);
    const countryCode = countryCodeRaw.startsWith('+')
      ? countryCodeRaw
      : `+${countryCodeRaw.replace(/\D/g, '')}`;

    if (!trimmedEmail.includes('@')) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }
    if (trimmedPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long' });
    }
    if (!/^\+\d{1,4}$/.test(countryCode)) {
      return res.status(400).json({ success: false, message: 'Please select a valid country code' });
    }
    if (country === 'IN') {
      if (!/^\d{10}$/.test(mobileNumber)) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a valid 10-digit mobile number without country code',
        });
      }
    } else if (!/^\d{6,15}$/.test(mobileNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid mobile number without country code',
      });
    }

    const existingByEmail = await User.findOne({ where: { email: trimmedEmail } });
    if (existingByEmail) {
      return res.status(400).json({ success: false, message: 'User already exists with this email' });
    }
    let existingByMobile = null;
    try {
      existingByMobile = await User.findOne({ where: { mobileNumber } });
    } catch (mobileCheckError) {
      if (!isUnknownMobileNumberColumnError(mobileCheckError)) {
        throw mobileCheckError;
      }
      // DB migration may still be pending; skip mobile uniqueness check temporarily.
    }
    if (existingByMobile) {
      return res.status(400).json({ success: false, message: 'User already exists with this mobile number' });
    }

    const otp = createOtpCode();
    const expiresAt = Date.now() + REGISTRATION_OTP_VALIDITY_MS;
    pendingRegisterOtps.set(trimmedEmail, {
      name: trimmedName,
      email: trimmedEmail,
      password: trimmedPassword,
      mobileNumber,
      country,
      countryCode,
      role: normalizedRole,
      otp,
      expiresAt,
    });

    try {
      await sendOTPEmail(trimmedEmail, otp);
    } catch (sendErr) {
      pendingRegisterOtps.delete(trimmedEmail);
      return res.status(400).json({
        success: false,
        message: `Failed to send OTP to email: ${sendErr.message}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email address',
      email: trimmedEmail,
      mobileNumber,
      expiresInSeconds: Math.floor(REGISTRATION_OTP_VALIDITY_MS / 1000),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send OTP',
    });
  }
};

exports.resendRegisterOtp = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const pending = pendingRegisterOtps.get(email);
    if (!pending) {
      return res.status(400).json({ success: false, message: 'No pending registration found. Please register again.' });
    }

    const otp = createOtpCode();
    const expiresAt = Date.now() + REGISTRATION_OTP_VALIDITY_MS;
    pendingRegisterOtps.set(email, { ...pending, otp, expiresAt });

    try {
      await sendOTPEmail(email, otp);
    } catch (sendErr) {
      return res.status(400).json({
        success: false,
        message: `Failed to send OTP to email: ${sendErr.message}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'OTP resent to your email address',
      expiresInSeconds: Math.floor(REGISTRATION_OTP_VALIDITY_MS / 1000),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to resend OTP',
    });
  }
};

exports.verifyRegisterOtp = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required' });
    }

    const pending = pendingRegisterOtps.get(email);
    if (!pending) {
      return res.status(400).json({ success: false, message: 'No pending registration found. Please register again.' });
    }

    if (Date.now() > pending.expiresAt) {
      return res.status(400).json({ success: false, message: 'OTP expired. Please resend OTP.' });
    }

    if (pending.otp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    const existingByEmail = await User.findOne({ where: { email: pending.email } });
    if (existingByEmail) {
      pendingRegisterOtps.delete(email);
      return res.status(400).json({ success: false, message: 'User already exists with this email' });
    }
    let existingByMobile = null;
    try {
      existingByMobile = await User.findOne({ where: { mobileNumber: pending.mobileNumber } });
    } catch (mobileCheckError) {
      if (!isUnknownMobileNumberColumnError(mobileCheckError)) {
        throw mobileCheckError;
      }
    }
    if (existingByMobile) {
      pendingRegisterOtps.delete(email);
      return res.status(400).json({ success: false, message: 'User already exists with this mobile number' });
    }

    const passwordToStore = looksLikeBcryptHash(pending.password)
      ? pending.password
      : await bcrypt.hash(pending.password, 10);

    const pricing = await resolvePricingContextFromRequest(
      {
        ...req,
        body: {
          ...(req.body || {}),
          country: pending.country,
          countryCode: pending.countryCode,
          mobileNumber: pending.mobileNumber,
        },
      },
      { mobileNumber: pending.mobileNumber, country: pending.country }
    );

    await ensureUsersIpColumn();
    await ensureUsersCurrentSessionIdColumn();
    const user = await User.create({
      name: pending.name,
      email: pending.email,
      mobileNumber: pending.mobileNumber,
      password: passwordToStore,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(pending.name)}&background=random`,
      role: pending.role || 'admin',
      country: pricing.country,
      currency: pricing.currency,
      ip: resolveRequestIp(req),
    });

    const sessionId = await issueUserSession(user.id);
    const token = generateToken(user.id, sessionId);

    pendingRegisterOtps.delete(email);

    return res.status(201).json({
      success: true,
      message: 'OTP verified and account created successfully',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobileNumber: user.mobileNumber,
        role: user.role,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to verify OTP',
    });
  }
};

exports.requestPasswordReset = async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || body.Email || body.EMAIL || '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    const user = await User.findOne({ where: { email } });

    // Do not reveal whether the email exists
    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If an account exists, you will receive an OTP shortly.'
      });
    }

    const otp = createOtpCode();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_OTP_VALIDITY_MS);
    const otpHash = hashPasswordResetOtp(otp);

    await PasswordResetToken.destroy({ where: { email, usedAt: null } });

    await PasswordResetToken.create({
      email,
      otpHash,
      expiresAt,
      usedAt: null
    });

    try {
      await sendOTPEmail(user.email, otp, 'password_reset');
    } catch (sendErr) {
      return res.status(500).json({
        success: false,
        message: `Failed to send OTP to email: ${sendErr.message}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email address',
      email,
      expiresInSeconds: Math.floor(PASSWORD_RESET_OTP_VALIDITY_MS / 1000),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to request password reset'
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || body.Email || body.EMAIL || '').trim().toLowerCase();
    const otp = String(body.otp || '').trim();
    const newPassword =
      body.newPassword || body.password || body.new_password || body.Password || body.PASSWORD || '';
    const trimmedNewPassword = String(newPassword).trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required' });
    }
    if (!trimmedNewPassword || trimmedNewPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long' });
    }

    const pending = await PasswordResetToken.findOne({
      where: { email, usedAt: null },
    });

    if (!pending) {
      return res.status(400).json({ success: false, message: 'No pending password reset found. Please request again.' });
    }

    if (pending.expiresAt && pending.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: 'OTP expired. Please request again.' });
    }

    const otpHash = hashPasswordResetOtp(otp);
    if (pending.otpHash !== otpHash) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Account not found' });
    }

    user.password = trimmedNewPassword;
    await user.save();

    pending.usedAt = new Date();
    await pending.save();

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to reset password'
    });
  }
};

/** Logged-in change password — same OTP flow as forgot password, email from session. */
exports.requestChangePassword = async (req, res) => {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
  req.body = { ...(req.body || {}), email };
  return exports.requestPasswordReset(req, res);
};

exports.changePassword = async (req, res) => {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
  req.body = { ...(req.body || {}), email };
  return exports.resetPassword(req, res);
};

async function resolveOwnerProjectIds(projectId) {
  const pid = Number(projectId);
  let ownerProjectIds = [pid];
  let ownerId = null;
  try {
    const [ownerRows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [pid]);
    ownerId = ownerRows?.[0]?.user_id != null ? Number(ownerRows[0].user_id) : null;
    if (ownerId) {
      const [owned] = await db.query('SELECT id FROM projects WHERE user_id = ?', [ownerId]);
      const ids = (owned || [])
        .map((r) => Number(r.id))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) ownerProjectIds = [...new Set([pid, ...ids])];
    }
  } catch (_) {
    /* keep current project only */
  }
  return { ownerId, ownerProjectIds };
}

async function findTeamMemberForProject(projectId, targetId) {
  const { Op } = require('sequelize');
  const { getActiveProjectIdsForAgent } = require('../services/agentProjectService');
  const tid = Number(targetId);
  if (!Number.isInteger(tid) || tid <= 0) return null;

  const { ownerId, ownerProjectIds } = await resolveOwnerProjectIds(projectId);
  const pid = Number(projectId);

  let agent = await User.findOne({
    where: {
      id: tid,
      role: { [Op.in]: ['agent', 'admin', 'manager'] },
      projectId: { [Op.in]: ownerProjectIds },
    },
  });

  if (!agent) {
    const mappedIds = await getActiveProjectIdsForAgent(tid);
    if (mappedIds.includes(pid)) {
      agent = await User.findByPk(tid);
    }
  }

  if (!agent && ownerId === tid) {
    agent = await User.findByPk(tid);
    if (agent && !['agent', 'admin', 'manager'].includes(String(agent.role || '').toLowerCase())) {
      agent = null;
    }
  }

  if (!agent) {
    try {
      const [assignedRows] = await db.query(
        'SELECT 1 AS ok FROM conversations WHERE project_id = ? AND agent_id = ? LIMIT 1',
        [projectId, tid]
      );
      if (assignedRows?.length) {
        agent = await User.findByPk(tid);
        if (agent && !['agent', 'admin', 'manager'].includes(String(agent.role || '').toLowerCase())) {
          agent = null;
        }
      }
    } catch (_) {
      /* optional enrichment */
    }
  }

  return agent;
}

exports.listAgents = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const { Op } = require('sequelize');

    const agentAttrs = [
      'id',
      'name',
      'email',
      'avatar',
      'role',
      'status',
      'lastLogin',
      'permissions',
      'createdAt',
      'updatedAt',
    ];

    // Resolve sibling projects under the same owner so agents created on any of them appear.
    let ownerId = null;
    let ownerProjectIds = [projectId];
    try {
      const [ownerRows] = await db.query('SELECT user_id FROM projects WHERE id = ? LIMIT 1', [
        projectId,
      ]);
      ownerId = ownerRows?.[0]?.user_id != null ? Number(ownerRows[0].user_id) : null;
      if (ownerId) {
        const [owned] = await db.query('SELECT id FROM projects WHERE user_id = ?', [ownerId]);
        const ids = (owned || [])
          .map((r) => Number(r.id))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length) ownerProjectIds = [...new Set([projectId, ...ids])];
      }
    } catch (_) {
      /* keep current project only */
    }

    const byId = new Map();
    const addUsers = (rows) => {
      (rows || []).forEach((u) => {
        if (u?.id != null) byId.set(Number(u.id), u);
      });
    };

    addUsers(
      await User.findAll({
        where: {
          role: { [Op.in]: ['agent', 'admin', 'manager'] },
          projectId: { [Op.in]: ownerProjectIds },
        },
        attributes: agentAttrs,
        order: [['createdAt', 'DESC']],
      })
    );

    // Always include project owner (often admin with null/other projectId)
    if (ownerId && !byId.has(ownerId)) {
      const owner = await User.findByPk(ownerId, { attributes: agentAttrs });
      if (owner && ['admin', 'manager', 'agent'].includes(String(owner.role || '').toLowerCase())) {
        byId.set(ownerId, owner);
      }
    }

    // Include anyone already assigned on chats in this project (covers legacy null projectId agents)
    try {
      const [assignedRows] = await db.query(
        `SELECT DISTINCT agent_id AS id
         FROM conversations
         WHERE project_id = ?
           AND agent_id IS NOT NULL`,
        [projectId]
      );
      const assignedIds = (assignedRows || [])
        .map((r) => Number(r.id))
        .filter((n) => Number.isInteger(n) && n > 0 && !byId.has(n));
      if (assignedIds.length) {
        addUsers(
          await User.findAll({
            where: { id: { [Op.in]: assignedIds } },
            attributes: agentAttrs,
          })
        );
      }
    } catch (_) {
      /* optional enrichment */
    }

    try {
      const [mappedRows] = await db.query(
        `SELECT DISTINCT agent_id AS id
         FROM agent_projects
         WHERE project_id = ?
           AND is_active = 1`,
        [projectId]
      );
      const mappedIds = (mappedRows || [])
        .map((r) => Number(r.id))
        .filter((n) => Number.isInteger(n) && n > 0 && !byId.has(n));
      if (mappedIds.length) {
        addUsers(
          await User.findAll({
            where: { id: { [Op.in]: mappedIds } },
            attributes: agentAttrs,
          })
        );
      }
    } catch (_) {
      /* optional enrichment */
    }

    const users = [...byId.values()].sort((a, b) => {
      const ta = new Date(a?.createdAt || 0).getTime();
      const tb = new Date(b?.createdAt || 0).getTime();
      return tb - ta;
    });

    res.json({
      success: true,
      agents: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.updateAgent = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const targetId = Number(req.params.id);
    if (!targetId || Number.isNaN(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent id'
      });
    }

    const body = req.body || {};
    const { name, email, role, status } = body;

    const requesterRole = String(req.user?.role || '').toLowerCase().trim();
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Only admin/manager/agent can edit basic team member details
    if (!['admin', 'manager', 'agent'].includes(requesterRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const hasRoleChange = Object.prototype.hasOwnProperty.call(body, 'role');
    const hasPermissionsChange = Object.prototype.hasOwnProperty.call(body, 'permissions');
    if ((hasRoleChange || hasPermissionsChange) && requesterRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can change role or permissions'
      });
    }

    const agent = await findTeamMemberForProject(projectId, targetId);

    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }

    if (!['agent', 'admin', 'manager'].includes(String(agent.role || '').toLowerCase())) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }

    let newRole = null;
    if (role != null) {
      newRole = String(role).toLowerCase().trim();
      if (!['agent', 'admin', 'manager'].includes(newRole)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role'
        });
      }
    }

    let newStatus = null;
    if (status != null) {
      newStatus = String(status).toLowerCase().trim();
      if (!['active', 'inactive'].includes(newStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }
    }

    const effectiveRole = newRole || String(agent.role || '').toLowerCase().trim();
    const nextPermissions = getPermissionsForRole(
      effectiveRole,
      hasPermissionsChange ? body.permissions : effectiveRole === 'manager' ? agent.permissions : null
    );

    if (typeof name === 'string' && name.trim()) agent.name = name.trim();
    if (typeof email === 'string' && email.trim()) agent.email = email.trim().toLowerCase();
    if (newRole) agent.role = newRole;
    agent.permissions = nextPermissions;
    if (newStatus) agent.status = newStatus;

    if (Array.isArray(body.projectIds) && ['agent', 'manager'].includes(effectiveRole)) {
      const { setAgentProjects } = require('../services/agentProjectService');
      await setAgentProjects(agent.id, body.projectIds, req.user?.id || null);
    }

    await agent.save();

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        avatar: agent.avatar,
        role: agent.role,
        permissions: agent.permissions,
        status: agent.status,
        updatedAt: agent.updatedAt,
      }
    });
  } catch (error) {
    // Handle Sequelize validation errors (e.g. unique email)
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.deleteAgent = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const targetId = Number(req.params.id);
    if (!targetId || Number.isNaN(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent id'
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase().trim();
    if (requesterRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can delete agent'
      });
    }

    const agent = await findTeamMemberForProject(projectId, targetId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }

    const targetRole = String(agent.role || '').toLowerCase().trim();
    if (!['agent', 'admin', 'manager'].includes(targetRole)) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }

    await agent.destroy();

    return res.json({
      success: true,
      message: 'Agent deleted successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.getAgentProjects = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const targetId = Number(req.params.id);
    if (!targetId || Number.isNaN(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent id',
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase().trim();
    if (!['admin', 'manager'].includes(requesterRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    const agent = await findTeamMemberForProject(projectId, targetId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found',
      });
    }

    const { listAgentProjectIds } = require('../services/agentProjectService');
    const projectIds = await listAgentProjectIds(targetId);
    const projects = [];
    for (const id of projectIds) {
      const [rows] = await db.query(
        'SELECT id, project_name FROM projects WHERE id = ? LIMIT 1',
        [id]
      );
      if (rows?.[0]) projects.push(rows[0]);
    }

    return res.json({
      success: true,
      agentId: targetId,
      projectIds,
      projects,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.setAgentProjects = async (req, res) => {
  try {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;

    const targetId = Number(req.params.id);
    if (!targetId || Number.isNaN(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent id',
      });
    }

    const requesterRole = String(req.user?.role || '').toLowerCase().trim();
    if (requesterRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can assign projects',
      });
    }

    const agent = await findTeamMemberForProject(projectId, targetId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found',
      });
    }

    const projectIds = Array.isArray(req.body?.projectIds) ? req.body.projectIds : [];
    const normalizedIds = [
      ...new Set(
        projectIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    const ownerProjects = await Project.findByUser(req.user.id);
    const ownedIds = new Set((ownerProjects || []).map((p) => Number(p.id)));
    const invalid = normalizedIds.filter((id) => !ownedIds.has(id));
    if (invalid.length > 0) {
      return res.status(403).json({
        success: false,
        message: 'Cannot assign projects you do not own',
      });
    }

    const { setAgentProjects } = require('../services/agentProjectService');
    const activeIds = await setAgentProjects(targetId, normalizedIds, req.user?.id || null);

    return res.json({
      success: true,
      agentId: targetId,
      projectIds: activeIds,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

exports.login = async (req, res) => {
  console.log('------------------->>login ');
  
  try {
    const body = req.body || {};
    const email = body.email || body.Email || body.EMAIL || '';
    const password = body.password || body.Password || body.PASSWORD || '';

    if (!email || String(email).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    if (!password || String(password).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }

    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedPassword = String(password).trim();

    let user = await User.findOne({ where: { email: trimmedEmail } });
    if (!user) {
      // Production safeguard: some environments have legacy/case-variant table names.
      // Fallback to direct lookup in both table variants before failing credentials.
      for (const tableName of ['users', 'Users']) {
        try {
          const [rows] = await sequelize.query(
            `SELECT * FROM \`${tableName}\` WHERE email = :email LIMIT 1`,
            { replacements: { email: trimmedEmail } }
          );
          if (Array.isArray(rows) && rows.length > 0) {
            user = User.build(rows[0], { isNewRecord: false });
            break;
          }
        } catch (_) {
          // Ignore table missing errors and try next variant.
        }
      }
    }
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Backward compatibility:
    // If existing users were created with plaintext passwords in the DB,
    // bcrypt.compare will fail. Detect that case and upgrade password to bcrypt.
    let isPasswordMatch = false;
    if (looksLikeBcryptHash(user.password)) {
      isPasswordMatch = await user.comparePassword(trimmedPassword);
    } else {
      isPasswordMatch = String(user.password).trim() === String(trimmedPassword);
      if (isPasswordMatch) {
        user.password = await bcrypt.hash(trimmedPassword, 10);
        await user.save();
      }
    }
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login + client IP
    await ensureUsersIpColumn();
    await ensureUsersCurrentSessionIdColumn();
    const clientIp = resolveRequestIp(req);
    // Single-session: rotate session id at every login (kicks out other devices/tabs).
    const sessionId = await issueUserSession(user.id);
    if (clientIp) {
      await User.update({ ip: clientIp, lastLogin: new Date() }, { where: { id: user.id } });
    } else {
      await User.update({ lastLogin: new Date() }, { where: { id: user.id } });
    }

    const token = generateToken(user.id, sessionId);
    const role = (user.role || '').toString().toLowerCase();
    const loginUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      role: role || 'agent',
      permissions: user.permissions,
      mobileNumber: user.mobileNumber || null
    };
    console.log('LOGIN USER:', loginUser);

    try {
      const [wccRows] = await db.query(
        'SELECT COALESCE(wcc_credits, 0) AS wcc FROM users WHERE id = ? LIMIT 1',
        [user.id]
      );
      const wccCredits = Number(wccRows?.[0]?.wcc) || 0;
      console.log('[Login][WCC] Balance in database (users.wcc_credits)', {
        userId: user.id,
        email: user.email,
        wccCredits,
        hint: 'Right panel / dashboard read the same value via GET /dashboard/:userId with x-project-id',
      });
    } catch (wccLogErr) {
      console.warn('[Login][WCC] Could not read users.wcc_credits (column may be missing)', wccLogErr?.message || wccLogErr);
    }

    let whatsappPayment = null;
    try {
      whatsappPayment = await getWhatsAppPaymentState(user.id, null);
    } catch (paymentCheckErr) {
      console.warn('[Login] WhatsApp payment check skipped', paymentCheckErr?.message || paymentCheckErr);
    }

    res.json({
      success: true,
      token,
      user: loginUser,
      whatsappPayment,
      paymentRequired: false,
      redirectUrl: null,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.getProfile = async (req, res) => {
  try {
    await ensureUsersAvatarLongText();
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const projectIdRaw =
      req.headers['x-project-id'] ??
      req.headers['x_project_id'] ??
      req.query?.projectId;
    const projectId = Number(projectIdRaw);
    const whatsappPayment = await getWhatsAppPaymentState(
      user.id,
      Number.isInteger(projectId) && projectId > 0 ? projectId : null
    );

    res.json({
      success: true,
      user: user.get({ plain: true }),
      whatsappPayment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    await ensureUsersAvatarLongText();
    const { displayName, email, whatsappNumber, countryCode, avatar } = req.body || {};

    if (!displayName || !String(displayName).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Display name is required'
      });
    }

    if (!email || !String(email).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const existingUser = await User.findOne({ where: { email: normalizedEmail } });
    if (existingUser && Number(existingUser.id) !== Number(user.id)) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists'
      });
    }

    const combinedWhatsAppNumber = `${String(countryCode || '').trim()}${String(whatsappNumber || '').trim()}`
      .replace(/\s+/g, '');

    const profileUpdates = {
      name: String(displayName).trim(),
      email: normalizedEmail
    };
    if (avatar !== undefined && avatar !== null && String(avatar).trim()) {
      const avatarValue = String(avatar).trim();
      if (avatarValue.length > 600000) {
        return res.status(400).json({
          success: false,
          message: 'Profile photo is too large. Please use an image under 500KB.'
        });
      }
      profileUpdates.avatar = avatarValue;
    }
    await user.update(profileUpdates);

    const settings = await Setting.findOne();
    if (settings) {
      await settings.update({
        adminName: String(displayName).trim(),
        adminEmail: normalizedEmail,
        whatsappNumber: combinedWhatsAppNumber || settings.whatsappNumber
      });
    }

    const updatedUser = await User.findByPk(user.id, {
      attributes: { exclude: ['password'] }
    });

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedUser ? updatedUser.get({ plain: true }) : null,
      meta: {
        whatsappNumber: combinedWhatsAppNumber
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
};