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
import { publicMutationRateLimit, publicReadRateLimit, publicResourceMutationRateLimit, publicSensitiveNoStore } from "../../middlewares/publicApiSecurity";

const router = Router();

const isTenantAdmin = checkAuth(UserRole.ADMIN);
const hasReviews     = checkFeature("reviews");

// ── Public routes (no auth, no feature gate) ──────────────────────────────────

// GET  /review/public/:token  → validate token & return job summary
router.get("/public/:token", publicSensitiveNoStore, publicReadRateLimit, reviewController.validateReviewToken);

// POST /review/public/:token  → submit review
router.post(
    "/public/:token",
    publicSensitiveNoStore,
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    zodValidate(reviewValidation.submitPublicReview, ValidationProperty.BODY),
    reviewController.submitPublicReview,
);

// ── Admin routes (feature-gated) ──────────────────────────────────────────────

// GET  /review/staff-summaries  → per-staff rating breakdown
router.get(
    "/staff-summaries",
    isTenantAdmin,
    hasReviews,
    reviewController.getStaffReviewSummaries,
);

// POST /review/generate-token/:jobId  → generate review token for a completed job
router.post(
    "/generate-token/:jobId",
    isTenantAdmin,
    hasReviews,
    reviewController.generateTokenForJob,
);

// GET /review/link-options -> canonical website state, active services, and recent completed jobs
router.get(
    "/link-options",
    isTenantAdmin,
    hasReviews,
    zodValidate(reviewValidation.reviewLinkOptionsQuery, ValidationProperty.QUERY),
    reviewController.getReviewLinkOptions,
);

// POST /review/share-link -> canonical company/service link or secure completed-job link
router.post(
    "/share-link",
    isTenantAdmin,
    hasReviews,
    zodValidate(reviewValidation.createReviewShareLink, ValidationProperty.BODY),
    reviewController.createReviewShareLink,
);

// GET  /review  → paginated list with filters
router.get(
    "/",
    isTenantAdmin,
    hasReviews,
    zodValidate(reviewValidation.reviewFilters, ValidationProperty.QUERY),
    reviewController.getAllReviews,
);

// POST /review/:id/resend-email  → resend review request email
router.post(
    "/:id/resend-email",
    isTenantAdmin,
    hasReviews,
    reviewController.resendReviewEmail,
);

// GET  /review/:id  → single review
router.get(
    "/:id",
    isTenantAdmin,
    hasReviews,
    reviewController.getReviewById,
);

// PATCH /review/:id  → update status / publish / reply
router.patch(
    "/:id",
    isTenantAdmin,
    hasReviews,
    zodValidate(reviewValidation.updateReview, ValidationProperty.BODY),
    reviewController.updateReview,
);

export const reviewRoutes = router;
