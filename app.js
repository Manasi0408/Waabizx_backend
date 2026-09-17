const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const helmet = require('helmet');
const { sequelize, syncDatabase } = require('./models');
const logger = require('./utils/logger');
const apiFailureLogger = require('./middleware/apiFailureLogger');
const { corsMiddleware, applyCorsHeaders } = require('./middleware/corsMiddleware');

// Import routes
const authRoutes = require('./routes/authRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const broadcastRoutes = require('./routes/broadcastRoutes');
const contactRoutes = require('./routes/contactRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const templateRoutes = require('./routes/templateRoutes');
const settingRoutes = require("./routes/settingRoutes");
const metaWebhookRoutes = require('./routes/metaWebhookRoutes');
const metaMessageRoutes = require('./routes/metaMessageRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const inboxRoutes = require('./routes/inboxRoutes');
const messageRoutes = require('./routes/messageRoutes');
const contactManagementRoutes = require('./routes/contactManagementRoutes');
const mediaRoutes = require('./routes/mediaRoutes');
const chatbotRoutes = require('./routes/chatbotRoutes');
const projectRoutes = require('./routes/projectRoutes');
const agentRoutes = require('./modules/agentDashboard/agentRoutes');
const agentChatRoutes = require('./routes/agentChatRoutes');
const chatRoutes = require('./routes/chatRoutes');
const managerAgentRoutes = require('./routes/managerAgentRoutes');
const adminAgentMessagesRoutes = require('./routes/adminAgentMessagesRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const cannedMessageRoutes = require('./routes/cannedMessageRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const planRoutes = require('./routes/planRoutes');
const agentCannedMessageRoutes = require('./routes/agentCannedMessageRoutes');
const flowRoutes = require('./routes/flowRoutes');
const reportsRoutes = require('./routes/reportsRoutes');
const tagRoutes = require('./routes/tagRoutes');
const userAttributeRoutes = require('./routes/userAttributeRoutes');
const whatsappButtonRoutes = require('./routes/whatsappButtonRoutes');
const rcsRoutes = require('./routes/rcsRoutes');
const rcsWebhookRoutes = require('./routes/rcsWebhookRoutes');
const websiteLeadRoutes = require('./routes/websiteLeadRoutes');

// Initialize Express app
const app = express();
app.set('trust proxy', 1);

function resolveFrontendBuildDir() {
  const candidateDirs = [
    process.env.FRONTEND_BUILD_DIR,
    process.env.FRONTEND_BUILD_PATH,
    path.join(__dirname, 'build'),
    path.join(process.cwd(), 'build'),
    path.join(__dirname, '..', 'build'),
    path.join(__dirname, '..', 'frontend', 'aisensy', 'build'),
    path.join(process.cwd(), '..', 'frontend', 'aisensy', 'build'),
    path.join(__dirname, '..', 'public_html', 'build'),
    path.join(process.cwd(), '..', 'public_html', 'build'),
    path.join(__dirname, '..', 'public_html'),
    path.join(process.cwd(), '..', 'public_html')
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }

  return null;
}

const frontendBuildDir = resolveFrontendBuildDir();

// CORS must run before every other middleware (including helmet and body parsers).
app.use(corsMiddleware);

// Body parser middleware
app.use(express.json({ 
  limit: '10mb',
  strict: false
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Log failed inbound API calls → backend/logs/api-failures.log + terminal
app.use(apiFailureLogger);

// HTTP access log (failures also mirrored to api-failures.log by middleware above)
app.use(morgan((tokens, req, res) => {
  const status = Number(tokens.status(req, res) || 0);
  const line = [
    tokens.method(req, res),
    tokens.url(req, res),
    status,
    `${tokens['response-time'](req, res)} ms`,
  ].join(' ');
  if (status >= 400) {
    return `⚠️ ${line}`;
  }
  return line;
}));

// Serve uploaded files.
// Production proxies typically forward only `/api/*` to Node, so mount the same
// folder at `/api/uploads` (public) and keep `/uploads` for local/direct access.
const uploadsDir = path.join(__dirname, 'uploads');
const serveUploads = express.static(uploadsDir, {
  fallthrough: true,
  maxAge: '7d',
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=604800');
  },
});
app.use('/api/uploads', serveUploads);
app.use('/uploads', serveUploads);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Health check routes (nginx may proxy only /api/*)
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Test route
app.get('/api/test', (req, res) => {
  res.status(200).json({ message: 'API working' });
});

// Meta token exchange
app.post('/exchange-token', async (req, res) => {
  const { code } = req.body;

  try {
    const response = await axios.get(
      'https://graph.facebook.com/v23.0/oauth/access_token',
      {
        params: {
          client_id: process.env.META_APP_ID || 'YOUR_APP_ID',
          client_secret: process.env.META_APP_SECRET || 'YOUR_APP_SECRET',
          redirect_uri: process.env.META_REDIRECT_URI || 'https://your-ngrok-url/meta/callback',
          code: code
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    logger.logApiFailure({
      direction: 'outbound',
      operation: 'META_EXCHANGE_TOKEN',
      method: 'GET',
      url: 'graph.facebook.com/oauth/access_token',
      status: error?.response?.status || 500,
      message: error?.message || 'Token exchange failed',
      response: error?.response?.data || null,
      error,
    });
    res.status(500).send('Token exchange failed');
  }
});

// Meta routes
const metaRoutes = require('./routes/meta.routes');
app.use('/meta', metaRoutes);

// AiSensy-compatible Partner API (create business / save Direct API credentials)
const partnerRoutes = require('./routes/partnerRoutes');
app.use('/partner', partnerRoutes);
// AiSensy Partner API v1: base + partner/{partner_id}/business
app.use('/partner-apis/v1/partner', partnerRoutes);

// AiSensy-compatible Direct API (token regeneration for programmatic WhatsApp access)
const directApiRoutes = require('./routes/directApiRoutes');
app.use('/direct-apis', directApiRoutes);

// WhatsApp onboarding (AiSensy business + project → Meta Embedded Signup)
const onboardingRoutes = require('./routes/onboardingRoutes');
app.use('/api/onboarding', onboardingRoutes);

// API routes (UNCHANGED)
app.use('/api/auth', authRoutes);
app.use('/api', adminAgentMessagesRoutes);
app.use('/api', superAdminRoutes);
const blogRoutes = require('./routes/blogRoutes');
app.use('/api/blogs', blogRoutes);
app.use('/api', planRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/broadcast', broadcastRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api', tagRoutes);
app.use('/api', userAttributeRoutes);
app.use('/api/whatsapp-buttons', whatsappButtonRoutes);
app.use('/api/rcs', rcsRoutes);
app.use('/webhooks/rcs', rcsWebhookRoutes);
app.use('/api', websiteLeadRoutes);
app.use('/api/contact-management', contactManagementRoutes);
app.use('/api/dashboard', dashboardRoutes);
const profileRoutes = require('./routes/profileRoutes');
app.use('/api', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/canned-messages', cannedMessageRoutes);
app.use('/api/agent/canned-messages', agentCannedMessageRoutes);
app.use('/api', flowRoutes);
const metaFlowRoutes = require('./routes/metaFlowRoutes');
app.use('/api/meta', metaFlowRoutes);
app.use('/api/reports', reportsRoutes);
app.use("/api/settings", settingRoutes);
app.use('/webhook', metaWebhookRoutes);
app.use('/messages', metaMessageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/contact-management', contactManagementRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', agentRoutes);
app.use('/api/agent/chat', agentChatRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api', managerAgentRoutes);
app.use('/api/payments', paymentRoutes);
const uploadRoutes = require('./routes/uploadRoutes');
app.use('/api/files', uploadRoutes);
app.use('/api/project-api-token', require('./routes/projectApiTokenRoutes'));

// direct-api routes (CORS for customer domains registered on API tokens)
const { directApiCorsMiddleware } = require('./middleware/directApiCors');
app.use('/direct-api/sendMessage', directApiCorsMiddleware);
app.use('/direct-api/sendMessage', require('./routes/projectApiTokenRoutes'));

// Serve React build
if (frontendBuildDir) {
  app.use(express.static(frontendBuildDir));

  const spaIndexPath = path.join(frontendBuildDir, 'index.html');

  const shouldServeSpa = (reqPath) =>
    !reqPath.startsWith('/api/') &&
    !reqPath.startsWith('/meta/') &&
    !reqPath.startsWith('/webhook') &&
    !reqPath.startsWith('/messages') &&
    !reqPath.startsWith('/uploads') &&
    !reqPath.startsWith('/api/uploads') &&
    !reqPath.startsWith('/partner') &&
    !reqPath.startsWith('/direct-apis');

  const serveSpaIndex = (req, res, next) => {
    if (!shouldServeSpa(req.path)) {
      return next();
    }
    if (!fs.existsSync(spaIndexPath)) {
      return res.status(503).json({
        success: false,
        message: 'Frontend build index.html not found on server',
      });
    }
    return res.sendFile(spaIndexPath, (err) => {
      if (err) next(err);
    });
  };

  // Express 5 wildcard (SPA client routes e.g. /login)
  app.get('/{*splat}', serveSpaIndex);
} else {
  console.error('Frontend build not found. Checked standard build directories and no index.html was present.');
}

// 404 handler
app.use((req, res) => {
  applyCorsHeaders(req, res);
  res.locals.apiErrorMessage = 'Route not found';
  res.locals.apiErrorBody = { success: false, message: 'Route not found' };
  res.status(404).json(res.locals.apiErrorBody);
});

// Error handler
app.use((err, req, res, next) => {
  applyCorsHeaders(req, res);

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    res.locals.apiErrorMessage = 'Invalid JSON in request body';
    res.locals.apiErrorBody = {
      success: false,
      message: 'Invalid JSON in request body',
    };
    return res.status(400).json(res.locals.apiErrorBody);
  }

  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  res.locals.apiErrorMessage = message;
  res.locals.apiErrorStack = err.stack || null;
  res.locals.apiErrorBody = { success: false, message };

  logger.error(`API error ${req.method} ${req.originalUrl || req.url}`, err);

  res.status(status).json(res.locals.apiErrorBody);
});

// DB connection
const connectDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connected');
    await syncDatabase();
    console.log('Database sync completed');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }
};

connectDatabase();

module.exports = app;