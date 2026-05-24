import { Router } from "express";
import { reviewController } from "./review.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { reviewValidation } from "./review.validation";

const router = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────────

// GET  /review/public/:token  → validate token & return job summary
router.get(
  "/public/:token",
  reviewController.validateReviewToken,
);

// POST /review/public/:token  → submit review
router.post(
  "/public/:token",
  zodValidate(reviewValidation.submitPublicReview, ValidationProperty.BODY),
  reviewController.submitPublicReview,
);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET  /review/staff-summaries  → per-staff rating breakdown
router.get(
  "/staff-summaries",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  reviewController.getStaffReviewSummaries,
);

// POST /review/generate-token/:jobId  → generate review token for a completed job
router.post(
  "/generate-token/:jobId",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  reviewController.generateTokenForJob,
);

// GET  /review         → paginated list with filters
router.get(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  reviewController.getAllReviews,
);

// GET  /review/:id     → single review
router.get(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  reviewController.getReviewById,
);

// PATCH /review/:id    → update status / publish / reply
router.patch(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(reviewValidation.updateReview, ValidationProperty.BODY),
  reviewController.updateReview,
);

export const reviewRoutes = router;
