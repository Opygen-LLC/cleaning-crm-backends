/**
 * review.routes.ts
 *
 * CHANGE: Added checkFeature("reviews") gate to all ADMIN read/write
 * routes so the GROWTH-plan restriction is enforced at the API layer.
 * Public review-submission routes (no auth) remain ungated.
 */

import { Router } from "express";
import { reviewController } from "./review.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { reviewValidation } from "./review.validation";

const router = Router();

const isAdminOrSuper = checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN);
// SUPER_ADMIN is exempt from the feature gate (no subscription on file).
// checkFeature already passes through when role !== ADMIN, so it is safe
// to chain it after isAdminOrSuper.
const hasReviews     = checkFeature("reviews");

// ── Public routes (no auth, no feature gate) ──────────────────────────────────

// GET  /review/public/:token  → validate token & return job summary
router.get("/public/:token", reviewController.validateReviewToken);

// POST /review/public/:token  → submit review
router.post(
    "/public/:token",
    zodValidate(reviewValidation.submitPublicReview, ValidationProperty.BODY),
    reviewController.submitPublicReview,
);

// ── Admin routes (feature-gated) ──────────────────────────────────────────────

// GET  /review/staff-summaries  → per-staff rating breakdown
router.get(
    "/staff-summaries",
    isAdminOrSuper,
    hasReviews,
    reviewController.getStaffReviewSummaries,
);

// POST /review/generate-token/:jobId  → generate review token for a completed job
router.post(
    "/generate-token/:jobId",
    isAdminOrSuper,
    hasReviews,
    reviewController.generateTokenForJob,
);

// GET  /review  → paginated list with filters
router.get(
    "/",
    isAdminOrSuper,
    hasReviews,
    reviewController.getAllReviews,
);

// POST /review/:id/resend-email  → resend review request email
router.post(
    "/:id/resend-email",
    isAdminOrSuper,
    hasReviews,
    reviewController.resendReviewEmail,
);

// GET  /review/:id  → single review
router.get(
    "/:id",
    isAdminOrSuper,
    hasReviews,
    reviewController.getReviewById,
);

// PATCH /review/:id  → update status / publish / reply
router.patch(
    "/:id",
    isAdminOrSuper,
    hasReviews,
    zodValidate(reviewValidation.updateReview, ValidationProperty.BODY),
    reviewController.updateReview,
);

export const reviewRoutes = router;
