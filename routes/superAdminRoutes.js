const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/roleMiddleware");
const {
  getAllAdmins,
  getAdminContacts,
  getBusinessOverview,
  downloadBusinessWccReport,
  adjustProjectWcc,
  transferProjectPlan,
} = require("../controllers/superAdminController");
const {
  getProjectWccTransactions,
  downloadProjectWccTransactions,
} = require("../controllers/wccSettingsController");

// SuperAdmin endpoints
router.get("/admins", protect, authorize("super_admin"), getAllAdmins);
router.get(
  "/admins/:adminId/contacts",
  protect,
  authorize("super_admin"),
  getAdminContacts
);
router.get(
  "/business-overview",
  protect,
  authorize("super_admin", "superadmin"),
  getBusinessOverview
);
router.get(
  "/business-overview/report",
  protect,
  authorize("super_admin", "superadmin"),
  downloadBusinessWccReport
);
router.patch(
  "/business-overview/:projectId/wcc",
  protect,
  authorize("super_admin", "superadmin"),
  adjustProjectWcc
);
router.patch(
  "/business-overview/:projectId/plan/transfer",
  protect,
  authorize("super_admin", "superadmin"),
  transferProjectPlan
);
router.get(
  "/business-overview/:projectId/wcc-transactions",
  protect,
  authorize("super_admin", "superadmin"),
  getProjectWccTransactions
);
router.get(
  "/business-overview/:projectId/wcc-transactions/download",
  protect,
  authorize("super_admin", "superadmin"),
  downloadProjectWccTransactions
);

module.exports = router;
