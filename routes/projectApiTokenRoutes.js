const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const controller = require('../controllers/projectApiTokenController');

router.get('/', controller.sendMessage);
router.get('/sendMessage', controller.sendMessage);
router.post('/', controller.sendMessage);
router.post('/sendMessage', controller.sendMessage);
router.get('/welcome', controller.welcomePage);

router.use(protect);

router.get('/status', controller.getStatus);
router.post('/create', controller.createToken);
router.post('/update', controller.updateToken);
router.post('/template', controller.setTemplate);
router.post('/revoke', controller.revokeToken);

module.exports = router;
