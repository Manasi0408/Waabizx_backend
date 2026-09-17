const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const blogController = require('../controllers/blogController');

const superAdminOnly = [protect, authorize('super_admin', 'superadmin')];

// Public read APIs for other websites (techwhizzc.com etc.) — no auth
router.get('/public', blogController.listPublicBlogs);
router.get('/public/:id', blogController.getPublicBlog);
router.get('/media/:filename', blogController.serveBlogMedia);

router.post(
  '/inline-image',
  ...superAdminOnly,
  blogController.uploadBlogImage,
  blogController.uploadInlineBlogImage
);

router.get('/', ...superAdminOnly, blogController.listBlogs);
router.get('/:id', ...superAdminOnly, blogController.getBlog);
router.post(
  '/',
  ...superAdminOnly,
  blogController.uploadBlogImage,
  blogController.createBlog
);
router.put(
  '/:id',
  ...superAdminOnly,
  blogController.uploadBlogImage,
  blogController.updateBlog
);
router.delete('/:id', ...superAdminOnly, blogController.deleteBlog);

module.exports = router;
