const router = require('express').Router();
const metaController = require('../controllers/meta.controller');
const { protect } = require('../middleware/authMiddleware');

router.get('/connect', metaController.getConnectUrl);
router.get('/callback', metaController.handleCallback);
router.post('/onboard', metaController.handleOnboard);
router.post('/embedded-signup-client-log', metaController.logEmbeddedSignupClientEvent);
router.get('/onboarding-status', metaController.getOnboardingStatus);
router.post('/register-phone', protect, metaController.registerCloudApiPhone);
router.post('/request-phone-code', protect, metaController.requestPhoneVerificationCode);
router.post('/verify-phone-code', protect, metaController.verifyPhoneOtpCode);

module.exports = router;
