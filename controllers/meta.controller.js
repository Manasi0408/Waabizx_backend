const metaService = require('../services/meta.service');
const { getProjectId } = require('../utils/projectScope');
const db = require('../config/db');
const logger = require('../utils/logger');
const { logEmbeddedSignupApi } = require('../utils/embeddedSignupLogger');

const protoAndHost = (req) => {
  const host = String(req.get('host') || '').trim();
  if (!host) return null;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwardedProto || (req.secure ? 'https' : req.protocol) || 'https';
  return { proto, host };
};

const META_POPUP_STORAGE_KEY = 'waabiz-meta-popup-result';

/**
 * OAuth redirect_uri sent to Meta /dialog/oauth and used in token exchange.
 * Must always be /meta/callback — never derive from the current route (/meta/connect).
 */
const resolveMetaOAuthRedirectUri = (req) => {
  const fromEnv = String(process.env.META_REDIRECT_URI || process.env.REDIRECT_URI || '').trim();
  if (fromEnv) {
    return metaService.normalizeMetaOAuthRedirectUri(fromEnv);
  }
  const ph = protoAndHost(req);
  if (!ph) {
    // return metaService.normalizeMetaOAuthRedirectUri('https://wabizx.techwhizzc.com/meta/callback');
    return metaService.normalizeMetaOAuthRedirectUri('https://api.waabizx.com/meta/callback');
  }
  const derived = `${ph.proto}://${ph.host}/meta/callback`;
  return metaService.normalizeMetaOAuthRedirectUri(derived);
};

/** Where to send the user / postMessage after OAuth (app tab, not callback host). */
const resolveOAuthReturnOrigin = (req, parsedState) => {
  const fromState = String(parsedState?.returnOrigin || '').trim().replace(/\/$/, '');
  if (fromState && /^https?:\/\//i.test(fromState)) {
    return fromState;
  }
  const frontend = String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  if (frontend) return frontend;
  const fromRedirect = String(process.env.META_REDIRECT_URI || process.env.REDIRECT_URI || '')
    .replace(/\/meta\/callback\/?$/i, '')
    .replace(/\/$/, '');
  if (fromRedirect && !fromRedirect.includes('ngrok')) return fromRedirect;
  const ph = protoAndHost(req);
  if (ph) return `${ph.proto}://${ph.host}`;
  // return 'https://wabizx.techwhizzc.com';
  return 'https://app.waabizx.com';
};

/** What Meta sends to GET /meta/callback (query string only). */
function callbackRequestPayload({ stateRaw, code }) {
  return {
    route: 'GET /meta/callback',
    query: {
      state: stateRaw || null,
      code: code ? '[received]' : null,
    },
  };
}

/** What we return to the browser popup / JSON client (not internal pipeline fields). */
function callbackResponseLog(popupPayload) {
  return {
    httpStatus: 200,
    type: popupPayload?.type || null,
    status: popupPayload?.status || null,
    message: popupPayload?.message || null,
    whatsappConnected: Boolean(popupPayload?.whatsappConnected),
    metaLinked: Boolean(popupPayload?.metaLinked),
  };
}

function isMetaOnboardingComplete(status, result) {
  return Boolean(
    status?.onboardingCompleted ||
      status?.metaLinked ||
      status?.readyToSendMessages ||
      status?.connected ||
      result?.onboardingCompleted ||
      result?.metaLinked ||
      result?.aisensyLinked ||
      result?.aisensySubmitFbToken?.ok ||
      (result?.wabaId && result?.phoneNumberId)
  );
}

/**
 * GET /meta/connect — generate Meta Embedded Signup OAuth URL.
 * Query: client_id (required), projectId (optional), redirect=1 to HTTP-redirect.
 */
exports.getConnectUrl = async (req, res) => {
  try {
    const fromQuery = parseInt(req.query.client_id, 10);
    const fromUser = req.user?.id != null ? Number(req.user.id) : null;
    const clientId =
      Number.isInteger(fromQuery) && fromQuery > 0
        ? fromQuery
        : Number.isInteger(fromUser) && fromUser > 0
          ? fromUser
          : null;

    const requestMeta = {
      method: 'GET',
      url: '/meta/connect',
      query: {
        client_id: clientId,
        projectId: req.query.projectId || null,
        redirect: req.query.redirect || null,
        redirect_uri: req.query.redirect_uri || null,
        returnOrigin: req.query.returnOrigin || req.query.return_origin || null,
      },
    };

    if (!clientId) {
      const body = { success: false, message: 'client_id is required' };
      logEmbeddedSignupApi('ES_HTTP_META_CONNECT', requestMeta, null, {
        httpStatus: 400,
        ...body,
      });
      return res.status(400).json(body);
    }

    const projectIdFromQuery = parseInt(req.query.projectId, 10);
    const scopedProject =
      Number.isInteger(projectIdFromQuery) && projectIdFromQuery > 0
        ? projectIdFromQuery
        : getProjectId(req);

    const redirectUri =
      String(req.query.redirect_uri || '').trim() || resolveMetaOAuthRedirectUri(req);
    const returnOrigin = String(req.query.returnOrigin || req.query.return_origin || '').trim();

    const pageFlow = String(req.query.redirect || '').trim() === '1';
    const solutionId = await metaService.resolveMetaSolutionId();
    if (!solutionId) {
      const body = {
        success: false,
        billingPath: 'A_aisensy_partner',
        message:
          'Path A requires META_SOLUTION_ID (AiSensy partner billing). Set it in backend .env.',
      };
      logEmbeddedSignupApi('ES_HTTP_META_CONNECT', requestMeta, null, {
        httpStatus: 503,
        ...body,
      });
      return res.status(503).json(body);
    }
    const url = metaService.buildEmbeddedSignupOAuthUrl({
      clientId,
      projectId: scopedProject,
      redirectUri,
      pageFlow,
      solutionId,
      returnOrigin: returnOrigin || undefined,
    });

    if (pageFlow) {
      logEmbeddedSignupApi('ES_HTTP_META_CONNECT', requestMeta, null, {
        httpStatus: 302,
        billingPath: 'A_aisensy_partner',
        redirect: url,
        solutionId,
      });
      return res.redirect(url);
    }

    const jsonBody = {
      success: true,
      billingPath: 'A_aisensy_partner',
      url,
      clientId,
      projectId: scopedProject != null ? Number(scopedProject) : null,
      redirectUri,
      solutionId,
      configId: String(process.env.META_CONFIG_ID || process.env.REACT_APP_META_CONFIG_ID || '').trim(),
    };
    logEmbeddedSignupApi('ES_HTTP_META_CONNECT', requestMeta, null, {
      httpStatus: 200,
      ...jsonBody,
    });
    return res.json(jsonBody);
  } catch (error) {
    const body = {
      success: false,
      message: error.message || 'Failed to build Meta connect URL',
    };
    logEmbeddedSignupApi(
      'ES_HTTP_META_CONNECT',
      { method: 'GET', url: '/meta/connect', query: req.query },
      null,
      { httpStatus: 500, ...body }
    );
    return res.status(500).json(body);
  }
};

exports.handleCallback = async (req, res) => {
  const code = req.query.code;
  const stateRaw = req.query.state;
  const parsedState = metaService.parseOAuthState(stateRaw);
  const clientId = parsedState.clientId;
  const oauthProjectId = parsedState.projectId;
  const pageFlow = parsedState.pageFlow;
  const scopedProjectId = oauthProjectId ?? getProjectId(req);

  try {
    if (!code) {
      const responseBody = {
        httpStatus: 400,
        success: false,
        onboardingCompleted: false,
        message: 'Missing code in callback',
      };
      logEmbeddedSignupApi(
        'ES_HTTP_META_CALLBACK',
        { method: 'GET', url: '/meta/callback' },
        callbackRequestPayload({ stateRaw, code }),
        responseBody
      );
      return res.status(400).json(responseBody);
    }
    if (!clientId) {
      const responseBody = {
        httpStatus: 400,
        success: false,
        onboardingCompleted: false,
        message: 'Missing or invalid state/client id in callback',
      };
      logger.metaCallbackPayloadResponse(
        'META_CALLBACK',
        callbackRequestPayload({ stateRaw, code }),
        { httpStatus: 400, success: false, message: responseBody.message }
      );
      return res.status(400).json(responseBody);
    }

    const callbackRedirectUri = resolveMetaOAuthRedirectUri(req);
    const requestPayload = callbackRequestPayload({ stateRaw, code });

    const result = await metaService.completeOnboarding(
      code,
      clientId,
      scopedProjectId,
      callbackRedirectUri,
      null
    );

    let status = await metaService.getOnboardingStatus(clientId, scopedProjectId);
    const whatsappConnected = isMetaOnboardingComplete(status, result);
    const onboardingCompleted = whatsappConnected;
    const wantsHtml = String(req.get('accept') || '').includes('text/html');
    const linkPid =
      oauthProjectId != null && Number(oauthProjectId) > 0
        ? Number(oauthProjectId)
        : scopedProjectId != null && Number(scopedProjectId) > 0
          ? Number(scopedProjectId)
          : null;
    let projectLabel = 'Your business';
    if (linkPid != null) {
      try {
        const [nameRows] = await db.query(
          'SELECT project_name FROM projects WHERE id = ? LIMIT 1',
          [linkPid]
        );
        const nm = nameRows?.[0]?.project_name;
        if (nm && String(nm).trim()) projectLabel = String(nm).trim();
      } catch (_) {
        /* non-fatal */
      }
    }
    const liveMessage = `${projectLabel} is Live now. You can continue with the further process.`;
    const siteOrigin = resolveOAuthReturnOrigin(req, parsedState);

    if (pageFlow) {
      const returnParams = new URLSearchParams();
      returnParams.set('onboardingOk', whatsappConnected ? '1' : '0');
      if (linkPid != null) returnParams.set('linkedProjectId', String(linkPid));
      const pageMessage = whatsappConnected
        ? liveMessage
        : 'Meta sign-in saved. Finish Cloud API registration if Meta still shows the number as pending.';
      returnParams.set('onboardingMessage', pageMessage);
      const returnUrl = `${siteOrigin}/connect-whatsapp?${returnParams.toString()}`;
      logger.metaCallbackPayloadResponse('META_CALLBACK', requestPayload, {
        httpStatus: 302,
        type: 'PAGE_FLOW_REDIRECT',
        success: true,
        whatsappConnected,
        redirect: returnUrl,
      });
      return res.redirect(returnUrl);
    }

    if (wantsHtml) {
      const title = whatsappConnected ? 'WABA LIVE' : 'Onboarding Pending';
      const popupPayloadObj = {
        source: 'waabiz-meta-oauth-popup',
        type: 'WHATSAPP_CONNECTED',
        status: whatsappConnected ? 'LIVE' : 'PENDING',
        whatsappConnected,
        metaLinked: Boolean(status?.metaLinked || result?.metaLinked),
        onboardingCompleted,
        creditLineAttached: Boolean(result?.creditLineAttached || status?.creditLineAttached),
        message: whatsappConnected
          ? liveMessage
          : 'Meta sign-in saved. Finish Cloud API registration if Meta still shows the number as pending.',
        linkedProjectId: linkPid,
        wabaId: status?.wabaId || result?.wabaId || null,
        phoneNumberId: status?.phoneNumberId || result?.phoneNumberId || null,
        displayPhone: status?.displayPhone || result?.displayPhone || null,
        eventId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      logger.metaCallbackPayloadResponse(
        'META_CALLBACK',
        requestPayload,
        callbackResponseLog(popupPayloadObj)
      );
      const popupPayload = JSON.stringify(popupPayloadObj);
      const siteOriginJson = JSON.stringify(siteOrigin);
      const storageKeyJson = JSON.stringify(META_POPUP_STORAGE_KEY);

      return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
      .card { max-width: 420px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 20px; box-shadow: 0 10px 30px rgba(2,132,199,.08); text-align: center; }
      .muted { color: #475569; font-size: 14px; margin: 8px 0 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2 style="margin:0;">Returning to Waabizx...</h2>
      <p class="muted">Please wait while this popup closes automatically.</p>
    </div>
    <script>
      (function () {
        var payload = ${popupPayload};
        var siteOrigin = ${siteOriginJson};
        var storageKey = ${storageKeyJson};
        try {
          localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch (_) {
          // Storage can fail in private mode; continue with postMessage/close.
        }
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, siteOrigin);
          }
        } catch (_) {
          // Continue with close attempt even if opener is inaccessible.
        }
        try {
          window.close();
        } catch (_) {
          // Ignore close failure and show fallback text below.
        }
        setTimeout(function () {
          if (!window.closed) {
            document.body.innerHTML =
              '<div style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;">' +
              '<div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;box-shadow:0 10px 30px rgba(2,132,199,.08);text-align:center;">' +
              '<h2 style="margin:0 0 10px;">Connection Complete</h2>' +
              '<p style="margin:0;color:#475569;">Return to the original Waabizx window. You can close this popup.</p>' +
              '</div></div>';
          }
        }, 1200);
      }());
    </script>
  </body>
</html>`);
    }

    const callbackJsonBody = {
      success: true,
      message: 'Meta onboarding callback processed',
      onboardingCompleted,
      whatsappConnected,
      metaLinked: Boolean(status?.metaLinked),
      callback: {
        clientId,
        state: stateRaw || null,
        codeReceived: true,
      },
      data: result,
      verification: status,
    };
    logger.metaCallbackPayloadResponse('META_CALLBACK', requestPayload, {
      httpStatus: 200,
      type: 'META_CALLBACK_JSON',
      success: true,
      whatsappConnected,
      message: callbackJsonBody.message,
    });
    return res.status(200).json(callbackJsonBody);
  } catch (err) {
    const errorMsg = err?.response?.data?.error?.message || err.message;
    logger.metaCallbackPayloadResponse(
      'META_CALLBACK',
      callbackRequestPayload({ stateRaw, code }),
      {
        httpStatus: 500,
        type: 'WHATSAPP_CONNECTION_FAILED',
        status: 'FAILED',
        success: false,
        message: errorMsg,
      }
    );
    logger.error('[Meta callback] failed', err?.response?.data || err);
    const wantsHtml = String(req.get('accept') || '').includes('text/html');
    if (wantsHtml) {
      const siteOrigin = resolveOAuthReturnOrigin(req, parsedState);
      const popupPayload = JSON.stringify({
        source: 'waabiz-meta-oauth-popup',
        type: 'WHATSAPP_CONNECTION_FAILED',
        status: 'FAILED',
        message: String(errorMsg || 'Unknown error'),
        eventId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const siteOriginJson = JSON.stringify(siteOrigin);
      const storageKeyJson = JSON.stringify(META_POPUP_STORAGE_KEY);

      return res.status(500).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Onboarding Failed</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
      .card { max-width: 420px; margin: 0 auto; background: #fff; border: 1px solid #fecaca; border-radius: 14px; padding: 20px; box-shadow: 0 10px 30px rgba(220,38,38,.08); text-align: center; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2 style="margin:0;">Returning to Waabizx...</h2>
      <p style="margin-top:10px;color:#475569;">The popup will close and the main page will show the error.</p>
      <p style="margin-top:8px;font-weight:600;color:#991b1b;">${String(errorMsg || 'Unknown error')}</p>
    </div>
    <script>
      (function () {
        var payload = ${popupPayload};
        var siteOrigin = ${siteOriginJson};
        var storageKey = ${storageKeyJson};
        try {
          localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch (_) {
          // Storage can fail in private mode; continue with postMessage/close.
        }
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, siteOrigin);
          }
        } catch (_) {
          // Continue with close attempt even if opener is inaccessible.
        }
        try {
          window.close();
        } catch (_) {
          // Ignore close failure and show fallback text below.
        }
        setTimeout(function () {
          if (!window.closed) {
            document.body.innerHTML =
              '<div style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a;">' +
              '<div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid #fecaca;border-radius:14px;padding:20px;box-shadow:0 10px 30px rgba(220,38,38,.08);text-align:center;">' +
              '<h2 style="margin:0 0 10px;">Connection Failed</h2>' +
              '<p style="margin:0;color:#991b1b;font-weight:600;">' + ${JSON.stringify(String(errorMsg || 'Unknown error'))} + '</p>' +
              '<p style="margin:10px 0 0;color:#475569;">Return to the original Waabizx window. You can close this popup.</p>' +
              '</div></div>';
          }
        }, 1200);
      }());
    </script>
  </body>
</html>`);
    }
    return res.status(500).json({
      success: false,
      onboardingCompleted: false,
      message: 'Onboarding failed during callback processing',
      error: errorMsg,
    });
  }
};

exports.handleOnboard = async (req, res) => {
  const pid = getProjectId(req);
  const requestMeta = {
    method: 'POST',
    url: '/meta/onboard',
  };
  const requestPayload = {
    client_id: req.body?.client_id != null ? parseInt(req.body.client_id, 10) : null,
    project_id: pid,
    redirect_uri:
      req.body?.redirect_uri !== undefined && req.body?.redirect_uri !== null
        ? String(req.body.redirect_uri)
        : null,
    codePresent: Boolean(req.body?.code),
    codeLength: req.body?.code ? String(req.body.code).length : 0,
  };

  try {
    const { code, client_id: clientId } = req.body;
    // Explicit empty string = Embedded Signup (FB.login) — omit redirect_uri on code exchange.
    // Missing field falls back to configured /meta/callback (redirect OAuth dialog flow).
    const redirectUri =
      req.body?.redirect_uri !== undefined && req.body?.redirect_uri !== null
        ? String(req.body.redirect_uri).trim()
        : resolveMetaOAuthRedirectUri(req);

    if (!code || clientId == null) {
      const responseBody = {
        httpStatus: 400,
        success: false,
        error: 'Missing code or client_id',
      };
      logger.metaCallbackPayloadResponse('META_ONBOARD', { route: 'POST /meta/onboard', body: requestPayload }, responseBody);
      logEmbeddedSignupApi('ES_HTTP_META_ONBOARD', requestMeta, requestPayload, responseBody);
      return res.status(400).json(responseBody);
    }

    logEmbeddedSignupApi(
      'ES_HTTP_META_ONBOARD_REDIRECT',
      requestMeta,
      {
        ...requestPayload,
        redirect_uri: redirectUri === '' ? '(omit — FB.login embedded signup)' : redirectUri,
      },
      { status: 'exchanging_code' }
    );

    const result = await metaService.completeOnboarding(
      code,
      parseInt(clientId, 10),
      pid,
      redirectUri,
      req.body?.registration_pin ?? req.body?.pin ?? null
    );

    const cid = parseInt(clientId, 10);
    let status = await metaService.getOnboardingStatus(cid, pid);
    const whatsappConnected = isMetaOnboardingComplete(status, result);

    const onboardJsonBody = {
      success: true,
      message: whatsappConnected
        ? 'Onboarding complete'
        : 'Meta tokens saved — WhatsApp linkage in progress',
      whatsappConnected,
      metaLinked: Boolean(status?.metaLinked || result?.metaLinked),
      onboardingCompleted: whatsappConnected,
      creditLineAttached: Boolean(result?.creditLineAttached || status?.creditLineAttached),
      redirectUrl: null,
      data: result,
      verification: status,
    };

    logger.metaCallbackPayloadResponse('META_ONBOARD', { route: 'POST /meta/onboard', body: requestPayload }, {
      httpStatus: 200,
      success: true,
      message: onboardJsonBody.message,
      whatsappConnected,
    });
    logEmbeddedSignupApi('ES_HTTP_META_ONBOARD', requestMeta, requestPayload, {
      httpStatus: 200,
      success: true,
      message: onboardJsonBody.message,
      whatsappConnected,
      data: result,
      verification: status,
    });

    res.json(onboardJsonBody);
  } catch (error) {
    const errorBody = {
      httpStatus: 500,
      success: false,
      error: 'Onboarding failed',
      message: error.response?.data?.error?.message || error.message,
      graph: error.response?.data || null,
    };
    logger.metaCallbackPayloadResponse('META_ONBOARD', { route: 'POST /meta/onboard', body: requestPayload }, errorBody);
    logEmbeddedSignupApi('ES_HTTP_META_ONBOARD', requestMeta, requestPayload, errorBody);
    logger.error('[Meta onboard POST] failed', error.response?.data || error);
    res.status(500).json(errorBody);
  }
};

/** Browser → server: log FB.login / postMessage / client Embedded Signup hops */
exports.logEmbeddedSignupClientEvent = (req, res) => {
  const operation = String(req.body?.operation || 'ES_CLIENT_EVENT').trim() || 'ES_CLIENT_EVENT';
  logEmbeddedSignupApi(
    operation.startsWith('ES_') ? operation : `ES_CLIENT_${operation}`,
    {
      method: 'CLIENT',
      url: req.body?.request?.url || 'browser',
      ...(req.body?.request && typeof req.body.request === 'object' ? req.body.request : {}),
    },
    req.body?.payload ?? null,
    req.body?.response ?? null
  );
  return res.json({ success: true, logged: true });
};

exports.getOnboardingStatus = async (req, res) => {
  try {
    const fromQuery = parseInt(req.query.client_id, 10);
    const fromState = parseInt(String(req.query.state || '').split(':')[0], 10);
    const clientId = Number.isInteger(fromQuery) && fromQuery > 0
      ? fromQuery
      : Number.isInteger(fromState) && fromState > 0
        ? fromState
        : null;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        onboardingCompleted: false,
        message: 'client_id is required',
      });
    }

    const fromHeader = getProjectId(req);
    const projectIdFromQuery = parseInt(req.query.projectId, 10);
    const scopedProject =
      Number.isInteger(projectIdFromQuery) && projectIdFromQuery > 0
        ? projectIdFromQuery
        : fromHeader;

    const status = await metaService.getOnboardingStatus(clientId, scopedProject);
    return res.status(200).json({
      success: true,
      ...status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      onboardingCompleted: false,
      message: 'Failed to fetch onboarding status',
      error: error.message,
    });
  }
};

/**
 * POST /meta/register-phone (auth) — Cloud API PIN registration (two-step verification).
 */
exports.registerCloudApiPhone = async (req, res) => {
  try {
    const clientId = req.user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const pin = req.body?.pin ?? req.body?.registration_pin;
    const region = req.body?.data_localization_region;
    const out = await metaService.registerCloudApiPhoneForLinkedAccount(
      Number(clientId),
      getProjectId(req),
      pin,
      { dataLocalizationRegion: region }
    );
    return res.json({ success: true, ...out });
  } catch (error) {
    const statusCode = Number(error.statusCode || error.status || 500) || 500;
    logger.error('[Meta register-phone]', error?.response?.data || error);
    return res.status(statusCode).json({
      success: false,
      message: error?.response?.data?.error?.message || error.message || 'Registration failed',
      graph: error?.graph || error?.response?.data,
    });
  }
};

/**
 * POST /meta/request-phone-code — Request SMS/Voice OTP for number verification (when Meta requires it).
 */
exports.requestPhoneVerificationCode = async (req, res) => {
  try {
    const clientId = req.user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const codeMethod = String(req.body?.code_method || req.query?.code_method || 'SMS');
    const language = String(req.body?.language || req.query?.language || 'en_US');
    const out = await metaService.requestCloudApiPhoneOtp(Number(clientId), getProjectId(req), {
      codeMethod,
      language,
    });
    return res.json({ success: true, ...out });
  } catch (error) {
    const statusCode = Number(error.statusCode || error.status || 500) || 500;
    logger.error('[Meta request-phone-code]', error?.response?.data || error);
    return res.status(statusCode).json({
      success: false,
      message: error?.response?.data?.error?.message || error.message || 'Failed to request code',
      graph: error?.graph || error?.response?.data,
    });
  }
};

/**
 * POST /meta/verify-phone-code — Submit OTP Meta sent before register.
 */
exports.verifyPhoneOtpCode = async (req, res) => {
  try {
    const clientId = req.user?.id;
    if (!clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const code = req.body?.code ?? req.body?.otp;
    if (code == null || String(code).trim() === '') {
      return res.status(400).json({ success: false, message: 'code is required' });
    }
    const out = await metaService.verifyCloudApiPhoneOtp(Number(clientId), getProjectId(req), code);
    return res.json({ success: true, ...out });
  } catch (error) {
    const statusCode = Number(error.statusCode || error.status || 500) || 500;
    logger.error('[Meta verify-phone-code]', error?.response?.data || error);
    return res.status(statusCode).json({
      success: false,
      message: error?.response?.data?.error?.message || error.message || 'OTP verification failed',
      graph: error?.graph || error?.response?.data,
    });
  }
};
