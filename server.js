const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET missing. Set it in backend/.env and restart the server.');
  process.exit(1);
}

const { isRazorpayConfigured } = require('./config/razorpay');
if (!isRazorpayConfigured()) {
  console.warn('⚠️  Razorpay not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env for payments.');
} else {
  console.log('✅ Razorpay configured from backend/.env');
}

const logger = require('./utils/logger');
const app = require('./app');

// Use Hostinger provided PORT
const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0';

let server;

try {
  // Start server
  server = app.listen(PORT, HOST, () => {
    logger.announceLogPaths();
    logger.writeLog(`Server running on http://${HOST}:${PORT}`);

    const { probePartnerApisOnStartup } = require('./services/aisensyPartnerApiClient');
    probePartnerApisOnStartup()
      .then((summary) => {
        logger.writeLog(
          `[aisensy-partner] All 3 APIs probed — see backend/logs/partner-api.log — ${JSON.stringify(summary?.apis ? {
            list: summary.apis.list?.ok ? 'OK' : 'FAIL',
            get: summary.apis.get?.ok ? 'OK' : 'SKIP',
            create: summary.apis.create?.ok ? 'OK' : 'SKIP',
          } : summary)}`
        );
      })
      .catch((e) => {
        console.warn('[aisensy-partner] startup probe:', e?.message || e);
        logger.error('[aisensy-partner] startup probe failed', e);
      });

    const { probeDirectApisOnStartup, getPrimaryDirectApiBase, getDirectApiSendPath } = require('./services/aisensyDirectApiClient');
    logger.writeLog(
      `[whatsapp-send] build=aisensy-direct-only | endpoint=${getPrimaryDirectApiBase()}${getDirectApiSendPath()} | graph.facebook.com sends=DISABLED`
    );
    probeDirectApisOnStartup()
      .then((summary) => {
        const bases = summary?.bases || {};
        logger.writeLog(
          `[aisensy-direct-api] Token + send probe — see backend/logs/direct-api.log — ${JSON.stringify({
            official: bases.official?.regenerate?.ok ? 'TOKEN_OK' : 'TOKEN_FAIL',
            self: bases.self?.regenerate?.ok ? 'TOKEN_OK' : bases.self ? 'TOKEN_FAIL' : 'N/A',
            send: Object.values(bases).some((b) => b.send?.ok) ? 'SEND_OK' : 'SEND_SKIP',
          })}`
        );
      })
      .catch((e) => {
        console.warn('[aisensy-direct-api] startup probe:', e?.message || e);
        logger.error('[aisensy-direct-api] startup probe failed', e);
      });

    const { runDueScheduledCampaigns } = require('./controllers/campaignController');
    runDueScheduledCampaigns().catch((e) => console.warn('[scheduled-campaigns] initial tick:', e?.message || e));
    setInterval(() => {
      runDueScheduledCampaigns().catch((e) => console.warn('[scheduled-campaigns] tick:', e?.message || e));
    }, 60 * 1000);
  });

  const { ensureWhatsAppAccountPaymentColumns } = require('./utils/ensureWhatsAppAccountSchema');
  ensureWhatsAppAccountPaymentColumns().catch((e) => {
    console.warn('[schema] whatsapp_accounts payment columns:', e?.message || e);
  });

  // Initialize Socket.IO (optional - safe wrapped)
  try {
    const socketService = require('./services/socketService');
    socketService.initializeSocket(server);
    console.log('✅ Socket.IO initialized');
  } catch (socketError) {
    console.error('⚠️ Socket init failed:', socketError.message);
  }

} catch (err) {
  console.error('❌ Server failed to start:', err);
  process.exit(1);
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection', err);
  logger.logApiFailure({
    direction: 'process',
    operation: 'UNHANDLED_REJECTION',
    message: err?.message || String(err),
    error: err,
  });
  if (server) {
    server.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
  logger.logApiFailure({
    direction: 'process',
    operation: 'UNCAUGHT_EXCEPTION',
    message: err?.message || String(err),
    error: err,
  });
  process.exit(1);
});

// Graceful shutdown (Hostinger uses this)
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  if (server) {
    server.close(() => {
      console.log('Process terminated.');
    });
  }
});