const express = require('express');
const router = express.Router();
const {
  register,
  requestRegisterOtp,
  resendRegisterOtp,
  verifyRegisterOtp,
  requestPasswordReset,
  resetPassword,
  requestChangePassword,
  changePassword,
  login,
  getProfile,
  updateProfile,
  listAgents,
  updateAgent,
  deleteAgent,
  getAgentProjects,
  setAgentProjects
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');

// Test endpoint to verify route is working
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Auth route is working',
    env: {
      hasJwtSecret: !!process.env.JWT_SECRET,
      hasJwtExpire: !!process.env.JWT_EXPIRE
    }
  });
});

// Debug endpoint - shows what server receives
router.post('/debug', (req, res) => {
  res.json({
    success: true,
    message: 'Debug endpoint - showing what server received',
    received: {
      body: req.body,
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'null',
      headers: req.headers,
      method: req.method,
      path: req.path
    },
    check: {
      hasName: !!req.body?.name,
      hasEmail: !!req.body?.email,
      hasPassword: !!req.body?.password,
      nameValue: req.body?.name || 'MISSING',
      emailValue: req.body?.email || 'MISSING',
      passwordValue: req.body?.password ? '***SET***' : 'MISSING'
    }
  });
});

router.post('/register', register);
router.post('/register/request-otp', requestRegisterOtp);
router.post('/register/resend-otp', resendRegisterOtp);
router.post('/register/verify-otp', verifyRegisterOtp);
router.post('/forgot-password/request', requestPasswordReset);
router.post('/forgot-password/reset', resetPassword);
router.post('/change-password/request', protect, authorize('admin', 'super_admin', 'superadmin'), requestChangePassword);
router.post('/change-password/reset', protect, authorize('admin', 'super_admin', 'superadmin'), changePassword);
router.post('/login', login);
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.get('/agents', protect, listAgents);
router.get('/agents/:id/projects', protect, getAgentProjects);
router.put('/agents/:id/projects', protect, setAgentProjects);
router.put('/agents/:id', protect, updateAgent);
router.delete('/agents/:id', protect, deleteAgent);

module.exports = router;