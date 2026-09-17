const express = require("express");

const { protect } = require("../middleware/authMiddleware");
const {
  listFlows,
  saveFlow,
  updateFlow,
  deleteFlow,
  getFlow,
  executeFlow,
  publishFlow,
  uploadFlowMediaMiddleware,
  uploadFlowMedia,
  listFlowMediaLibrary,
  deleteFlowMediaLibrary,
} = require("../controllers/flowController");

const router = express.Router();

router.get("/flows", protect, listFlows);
router.get("/flows/media-library", protect, listFlowMediaLibrary);
router.delete("/flows/media-library", protect, deleteFlowMediaLibrary);
router.post("/flows/media-library/delete", protect, deleteFlowMediaLibrary);
router.post("/flows", protect, saveFlow);
router.post("/flows/upload-media", protect, (req, res, next) => {
  uploadFlowMediaMiddleware(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "Video file is too large. Maximum size is 1 GB.",
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to upload media",
      });
    }
    return uploadFlowMedia(req, res);
  });
});
router.put("/flows/:flowId", protect, updateFlow);
router.delete("/flows/:flowId", protect, deleteFlow);
router.get("/flows/:flowId", protect, getFlow);
router.post("/flows/:flowId/publish", protect, publishFlow);
router.post("/flows/:flowId/execute", protect, executeFlow);

module.exports = router;

