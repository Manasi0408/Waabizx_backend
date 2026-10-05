const express = require('express');
const router = express.Router();

const {
  createProject,
  getProjects,
  getProjectById,
  getQualityRating,
  setProjectHidden,
  deleteProject,
} = require('../controllers/projectController');
const { getCurrentPlanLimits } = require('../controllers/planLimitController');

const { protect } = require('../middleware/authMiddleware');

// All routes require login
router.use(protect);

router.post('/create', createProject);
router.get('/list', getProjects);
router.get('/plan-limits', getCurrentPlanLimits);
router.get('/:projectId/quality-rating', getQualityRating);
router.get('/:id', getProjectById);
router.patch('/:id/hidden', setProjectHidden);
router.delete('/:id', deleteProject);

module.exports = router;

