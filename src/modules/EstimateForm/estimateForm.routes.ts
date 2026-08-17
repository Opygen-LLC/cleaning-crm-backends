import { Router } from "express";
import { estimateFormController } from "./estimateForm.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { estimateFormValidation } from "./estimateForm.validation";
import { publicMutationRateLimit, publicReadRateLimit, publicResourceMutationRateLimit } from "../../middlewares/publicApiSecurity";
import { publicSpamGuard } from "../../middlewares/publicSpamProtection";

const router = Router();

// Two distinct frontend gates share this router (see featureGateConfig.ts):
//   GATES.estimateForms       ("pricing forms")     — builder/list/CRUD pages
//   GATES.estimateSubmissions ("estimate submissions") — submissions inbox
const isAdmin = checkAuth(UserRole.ADMIN);
const hasPricingForms = checkFeature("pricing forms");
const hasEstimateSubmissions = checkFeature("estimate submissions");

// ── Public routes (no auth) ───────────────────────────────────────────────────
// Must be declared before /:id routes

router.get(
    "/public/:slug",
    publicReadRateLimit,
    estimateFormController.getPublicEstimateForm,
);

router.post(
    "/public/:slug/calculate",
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    zodValidate(estimateFormValidation.publicCalculation, ValidationProperty.BODY),
    estimateFormController.calculatePublicEstimate,
);

router.post(
    "/public/:slug/submit",
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    publicSpamGuard,
    zodValidate(estimateFormValidation.publicSubmission, ValidationProperty.BODY),
    estimateFormController.submitPublicEstimateForm,
);

// ── Submission management (admin) ─────────────────────────────────────────────

router.get(
    "/submissions",
    isAdmin,
    hasEstimateSubmissions,
    estimateFormController.getSubmissions,
);

router.patch(
    "/submissions/:submissionId/status",
    isAdmin,
    hasEstimateSubmissions,
    zodValidate(estimateFormValidation.updateSubmissionStatus, ValidationProperty.BODY),
    estimateFormController.updateSubmissionStatus,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    isAdmin,
    hasPricingForms,
    zodValidate(estimateFormValidation.createEstimateForm, ValidationProperty.BODY),
    estimateFormController.createEstimateForm,
);

router.get(
    "/",
    isAdmin,
    hasPricingForms,
    estimateFormController.getAllEstimateForms,
);

router.get(
    "/:id",
    isAdmin,
    hasPricingForms,
    estimateFormController.getEstimateFormById,
);

router.patch(
    "/:id",
    isAdmin,
    hasPricingForms,
    zodValidate(estimateFormValidation.updateEstimateForm, ValidationProperty.BODY),
    estimateFormController.updateEstimateForm,
);

router.delete(
    "/:id",
    isAdmin,
    hasPricingForms,
    estimateFormController.deleteEstimateForm,
);

router.patch(
    "/:id/toggle-published",
    isAdmin,
    hasPricingForms,
    estimateFormController.togglePublished,
);

// ── Per-form submissions ──────────────────────────────────────────────────────
// This lists submissions scoped to one form, so it's gated the same as the
// submissions inbox above, not the form-builder gate.

router.get(
    "/:id/submissions",
    isAdmin,
    hasEstimateSubmissions,
    estimateFormController.getFormSubmissions,
);

export const estimateFormRoutes = router;
