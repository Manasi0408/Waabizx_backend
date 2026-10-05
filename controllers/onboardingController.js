const crypto = require('crypto');
const { PartnerBusiness } = require('../models');
const Project = require('../models/Project');
const {
  createProject,
  resolveAisensyBusinessId,
} = require('../services/aisensyPartnerService');
const metaService = require('../services/meta.service');
const { getProjectId } = require('../utils/projectScope');
const logger = require('../utils/logger');
const { logEmbeddedSignupApi } = require('../utils/embeddedSignupLogger');

function getEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(String(process.env.JWT_SECRET || 'waabizx-partner-secret'))
    .digest();
}

function encryptSecret(plain) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function resolveMetaRedirectUri(req) {
  const fromEnv = String(process.env.META_REDIRECT_URI || process.env.REDIRECT_URI || '').trim();
  if (fromEnv) {
    return metaService.normalizeMetaOAuthRedirectUri(fromEnv);
  }
  const host = String(req.get('host') || '').trim();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwardedProto || (req.secure ? 'https' : req.protocol) || 'https';
  if (host) {
    return metaService.normalizeMetaOAuthRedirectUri(`${proto}://${host}/meta/callback`);
  }
  return metaService.normalizeMetaOAuthRedirectUri('https://api.waabizx.com/meta/callback');
}

async function findExistingOnboarding(userId, localProjectId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return null;

  // Scope to the selected local project only — never reuse another project's row.
  if (!Number.isInteger(localProjectId) || localProjectId <= 0) return null;

  return PartnerBusiness.findOne({
    where: { user_id: uid, project_id: localProjectId, active: true },
    order: [['id', 'DESC']],
  });
}

async function saveOnboardingRecord({
  customer,
  localProjectId,
  aisensyBusinessId,
  aisensyProjectId,
  companyName,
  email,
  mobile,
  plainPassword,
}) {
  const partnerId = String(
    process.env.AISENSY_PARTNER_ID || process.env.PARTNER_ID || ''
  ).trim();

  const existing = await findExistingOnboarding(customer.id, localProjectId);
  const fields = {
    business_id: String(aisensyBusinessId),
    external_project_id: String(aisensyProjectId),
    partner_id: partnerId || existing?.partner_id || 'aisensy',
    user_id: customer.id,
    project_id: localProjectId,
    display_name: String(companyName || customer.name || email).trim(),
    company: String(companyName || customer.name || '').trim() || null,
    contact: String(mobile || customer.mobileNumber || '').replace(/\D/g, '') || null,
    email: String(email || customer.email).trim().toLowerCase(),
    currency: 'INR',
    timezone: 'Asia/Calcutta GMT+05:30',
    active: true,
  };
  if (plainPassword) {
    fields.direct_api_password_enc = encryptSecret(plainPassword);
  }

  if (existing) {
    await existing.update(fields);
    logger.onboarding('SAVE_PARTNER_BUSINESS_UPDATED', {
      userId: customer.id,
      localProjectId,
      businessId: aisensyBusinessId,
      aisensyProjectId,
    });
    return existing;
  }

  // business_id is UNIQUE — if this AiSensy business is already mapped, update that row
  // only when it belongs to the same user+project; otherwise create fails with "Validation error".
  const byBusinessId = await PartnerBusiness.findOne({
    where: { business_id: String(aisensyBusinessId) },
  });
  if (byBusinessId) {
    const sameMapping =
      Number(byBusinessId.user_id) === Number(customer.id) &&
      Number(byBusinessId.project_id) === Number(localProjectId);
    if (sameMapping) {
      await byBusinessId.update(fields);
      logger.onboarding('SAVE_PARTNER_BUSINESS_UPDATED_BY_BUSINESS_ID', {
        userId: customer.id,
        localProjectId,
        businessId: aisensyBusinessId,
        aisensyProjectId,
      });
      return byBusinessId;
    }
    const err = new Error(
      'This AiSensy business is already linked to another project. A new business will be required for this project.'
    );
    err.statusCode = 409;
    err.response = {
      data: {
        business_id: aisensyBusinessId,
        existing_user_id: byBusinessId.user_id,
        existing_project_id: byBusinessId.project_id,
      },
    };
    throw err;
  }

  try {
    const created = await PartnerBusiness.create(fields);
    logger.onboarding('SAVE_PARTNER_BUSINESS_CREATED', {
      userId: customer.id,
      localProjectId,
      businessId: aisensyBusinessId,
      aisensyProjectId,
      rowId: created?.id,
    });
    return created;
  } catch (error) {
    // Sequelize unique/not-null failures often surface as plain "Validation error"
    const isValidation =
      error?.name === 'SequelizeUniqueConstraintError' ||
      error?.name === 'SequelizeValidationError' ||
      /validation error/i.test(String(error?.message || ''));
    if (isValidation) {
      const details = (error.errors || []).map((e) => ({
        path: e.path,
        message: e.message,
        value: e.value,
      }));
      logger.onboarding('SAVE_PARTNER_BUSINESS_VALIDATION_ERROR', {
        userId: customer.id,
        localProjectId,
        businessId: aisensyBusinessId,
        message: error.message,
        details,
      });
      const err = new Error(
        details[0]?.message ||
          error.message ||
          'Failed to save onboarding mapping (validation error)'
      );
      err.statusCode = 409;
      err.response = { data: { details, original: error.message } };
      throw err;
    }
    throw error;
  }
}

function generateEmbeddedSignupUrl({
  clientId,
  projectId,
  redirectUri,
  returnOrigin,
  solutionId,
}) {
  return metaService.buildEmbeddedSignupOAuthUrl({
    clientId,
    projectId,
    redirectUri,
    pageFlow: true,
    solutionId,
    returnOrigin: returnOrigin || undefined,
  });
}

/**
 * POST /api/onboarding/connect-whatsapp
 *
 * 1) Create Business (AiSensy)
 * 2) Create Project (AiSensy)
 * 3) Save businessId + projectId locally
 * 4) Generate Meta Embedded Signup URL
 * 5) Return URL to React
 */
exports.connectWhatsApp = async (req, res) => {
  try {
    const customer = req.user;
    if (!customer?.id) {
      logger.onboarding('CONNECT_WHATSAPP_UNAUTHORIZED', {});
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const body = req.body || {};
    const companyName = String(
      body.companyName || body.company_name || customer.name || ''
    ).trim();
    const email = String(body.email || customer.email || '')
      .trim()
      .toLowerCase();
    const mobile = String(
      body.mobile || body.mobileNumber || customer.mobileNumber || ''
    ).trim();
    const requestedProjectName = String(
      body.projectName || body.project_name || ''
    ).trim();

    let localProjectId =
      Number(body.projectId || body.project_id) ||
      getProjectId(req) ||
      null;
    if (!Number.isInteger(localProjectId) || localProjectId <= 0) {
      localProjectId = null;
    }

    // Prefer the Waabizx local project name so AiSensy display_name matches what the user created.
    let aisensyProjectDisplayName =
      requestedProjectName || companyName || customer.name || 'WhatsApp Project';
    if (localProjectId) {
      try {
        const localProject = await Project.findById(localProjectId);
        const localName = String(localProject?.project_name || '').trim();
        if (localName) aisensyProjectDisplayName = localName;
      } catch (_) {
        /* non-fatal */
      }
    }

    logger.onboardingPayloadResponse(
      'CONNECT_WHATSAPP_START',
      {
        userId: customer.id,
        email,
        companyName,
        mobile,
        localProjectId,
        aisensyProjectDisplayName,
      },
      { status: 'started' }
    );
    logEmbeddedSignupApi(
      'ES_HTTP_CONNECT_WHATSAPP_START',
      { method: 'POST', url: '/api/onboarding/connect-whatsapp' },
      {
        userId: customer.id,
        email,
        companyName,
        mobile,
        localProjectId,
        aisensyProjectDisplayName,
      },
      { status: 'started' }
    );

    let aisensyBusinessId = null;
    let aisensyProjectId = null;
    let plainPassword = null;
    let reusedBusiness = false;

    const existing = await findExistingOnboarding(customer.id, localProjectId);
    // Do NOT overwrite the selected local project with another project's mapping.

    // Step 1 — Resolve a business id that exists on AiSensy (not local-only hex).
    // For a new local project (no row yet), create a dedicated AiSensy business
    // so we never collide on unique partner_businesses.business_id.
    logger.onboarding('STEP1_RESOLVE_BUSINESS_CALLING', {
      userId: customer.id,
      email,
      localProjectId,
      storedBusinessId: existing?.business_id || null,
    });
    const resolvedBusiness = await resolveAisensyBusinessId(customer, existing, {
      companyName,
      email,
      mobile,
      // Only reuse email/env shared business when this local project already has a mapping.
      allowSharedBusiness: !!(existing?.business_id && existing?.external_project_id),
    });
    aisensyBusinessId = resolvedBusiness.id;
    plainPassword = resolvedBusiness.password || null;
    reusedBusiness = !!resolvedBusiness.reused;
    logger.onboardingPayloadResponse(
      'STEP1_RESOLVE_BUSINESS',
      { email, companyName, mobile, storedBusinessId: existing?.business_id || null },
      {
        businessId: aisensyBusinessId,
        source: resolvedBusiness.source,
        reused: reusedBusiness,
        createEmail: resolvedBusiness.createEmail || null,
      }
    );

    // Step 2 — Reuse existing AiSensy project for this local project; create only once.
    const existingExternalProjectId = existing?.external_project_id
      ? String(existing.external_project_id).trim()
      : '';
    const existingBusinessMatches =
      existing?.business_id &&
      String(existing.business_id).trim() === String(aisensyBusinessId).trim();

    if (existingExternalProjectId && existingBusinessMatches) {
      aisensyProjectId = existingExternalProjectId;
      logger.onboardingPayloadResponse(
        'STEP2_REUSE_PROJECT',
        { businessId: aisensyBusinessId, projectName: aisensyProjectDisplayName },
        { projectId: aisensyProjectId, reused: true }
      );
    } else {
      logger.onboarding('STEP2_CREATE_PROJECT_CALLING', {
        userId: customer.id,
        businessId: aisensyBusinessId,
        projectName: aisensyProjectDisplayName,
      });
      try {
        const project = await createProject(aisensyBusinessId, customer, {
          companyName,
          projectName: aisensyProjectDisplayName,
        });
        aisensyProjectId = project.projectId;
        logger.onboardingPayloadResponse(
          'STEP2_CREATE_PROJECT',
          {
            businessId: aisensyBusinessId,
            projectName: aisensyProjectDisplayName,
            payload: project.payload,
          },
          { projectId: aisensyProjectId, raw: project.raw }
        );
      } catch (error) {
        const fallbackExternalProjectId = existingExternalProjectId || null;

        logger.onboarding('STEP2_CREATE_PROJECT_FAILED', {
          userId: customer.id,
          businessId: aisensyBusinessId,
          message: error?.message || String(error),
          fallbackExternalProjectId,
        });

        if (fallbackExternalProjectId) {
          aisensyProjectId = fallbackExternalProjectId;
        } else {
          throw error;
        }
      }
    }

    // Ensure local project row exists
    if (!localProjectId) {
      localProjectId = await Project.create(
        customer.id,
        aisensyProjectDisplayName || companyName || customer.name || 'WhatsApp Project'
      );
      logger.onboarding('LOCAL_PROJECT_CREATED', {
        userId: customer.id,
        localProjectId,
      });
    }

    // Step 3 — Save businessId + projectId
    await saveOnboardingRecord({
      customer,
      localProjectId,
      aisensyBusinessId,
      aisensyProjectId,
      companyName: aisensyProjectDisplayName || companyName,
      email,
      mobile,
      plainPassword,
    });

    // Step 4 — Path A: Embedded Signup URL must include AiSensy solutionID
    const redirectUri = resolveMetaRedirectUri(req);
    const solutionId = await metaService.resolveMetaSolutionId();
    if (!solutionId) {
      logger.onboarding('STEP4_SOLUTION_ID_MISSING', {
        userId: customer.id,
        note: 'Path A blocked — META_SOLUTION_ID required for AiSensy partner billing',
      });
      return res.status(503).json({
        success: false,
        billingPath: 'A_aisensy_partner',
        message:
          'AiSensy Solution ID is not configured. Set META_SOLUTION_ID (Path A partner billing) and retry.',
      });
    }
    const returnOrigin = String(
      body.returnOrigin ||
        body.return_origin ||
        process.env.FRONTEND_URL ||
        ''
    )
      .trim()
      .replace(/\/$/, '');

    const signupUrl = generateEmbeddedSignupUrl({
      clientId: customer.id,
      projectId: localProjectId,
      redirectUri,
      returnOrigin: returnOrigin || undefined,
      solutionId,
    });

    const result = {
      success: true,
      billingPath: 'A_aisensy_partner',
      signupUrl,
      embeddedSignupUrl: signupUrl,
      businessId: aisensyBusinessId,
      projectId: aisensyProjectId,
      localProjectId,
      solutionId,
      reused: reusedBusiness,
      status: reusedBusiness ? 'READY' : 'CREATED',
    };

    logger.onboardingPayloadResponse(
      'CONNECT_WHATSAPP_SUCCESS',
      {
        userId: customer.id,
        businessId: aisensyBusinessId,
        aisensyProjectId,
        localProjectId,
        reusedBusiness,
        redirectUri,
        solutionId,
        hasSolutionId: Boolean(solutionId),
      },
      {
        success: true,
        status: result.status,
        signupUrlPreview: String(signupUrl || '').slice(0, 120),
      }
    );
    logEmbeddedSignupApi(
      'ES_HTTP_CONNECT_WHATSAPP_SUCCESS',
      { method: 'POST', url: '/api/onboarding/connect-whatsapp' },
      {
        userId: customer.id,
        businessId: aisensyBusinessId,
        aisensyProjectId,
        localProjectId,
        redirectUri,
        solutionId,
        returnOrigin: returnOrigin || null,
      },
      {
        success: true,
        status: result.status,
        signupUrl,
        businessId: aisensyBusinessId,
        projectId: aisensyProjectId,
        localProjectId,
        solutionId: solutionId || null,
      }
    );

    return res.json(result);
  } catch (error) {
    const sequelizeDetails = (error.errors || []).map((e) => ({
      path: e.path,
      message: e.message,
      value: e.value,
    }));
    const isDbValidation =
      error?.name === 'SequelizeUniqueConstraintError' ||
      error?.name === 'SequelizeValidationError' ||
      /validation error/i.test(String(error?.message || ''));
    const status =
      Number(error.statusCode) ||
      (isDbValidation ? 409 : 500);
    const message = isDbValidation
      ? sequelizeDetails[0]?.message ||
        error.message ||
        'Validation error while saving WhatsApp onboarding'
      : error.message || 'Failed to start WhatsApp onboarding';
    logEmbeddedSignupApi(
      'ES_HTTP_CONNECT_WHATSAPP_ERROR',
      { method: 'POST', url: '/api/onboarding/connect-whatsapp' },
      { body: req.body || {} },
      {
        httpStatus: status,
        success: false,
        message,
        sequelizeDetails,
      }
    );

    logger.onboardingPayloadResponse(
      'CONNECT_WHATSAPP_ERROR',
      {
        userId: req.user?.id || null,
        body: req.body || {},
      },
      {
        success: false,
        status,
        message,
        details: error.response?.data || sequelizeDetails || null,
      }
    );
    logger.error('CONNECT_WHATSAPP_ERROR', error);
    return res.status(status).json({
      success: false,
      message,
      details: error.response?.data || (sequelizeDetails.length ? sequelizeDetails : undefined),
    });
  }
};
