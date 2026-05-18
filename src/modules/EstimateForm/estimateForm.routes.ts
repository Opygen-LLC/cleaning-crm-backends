import { Router } from "express";
import { estimateFormController } from "./estimateForm.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { estimateFormValidation } from "./estimateForm.validation";

const router = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────────
// Must be declared before /:id routes

router.get(
    "/public/:slug",
    estimateFormController.getPublicEstimateForm,
);

router.post(
    "/public/:slug/submit",
    zodValidate(estimateFormValidation.publicSubmission, ValidationProperty.BODY),
    estimateFormController.submitPublicEstimateForm,
);

// ── Submission management (admin) ─────────────────────────────────────────────

router.get(
    "/submissions",
    checkAuth(UserRole.ADMIN),
    estimateFormController.getSubmissions,
);

router.patch(
    "/submissions/:submissionId/status",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateFormValidation.updateSubmissionStatus, ValidationProperty.BODY),
    estimateFormController.updateSubmissionStatus,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateFormValidation.createEstimateForm, ValidationProperty.BODY),
    estimateFormController.createEstimateForm,
);

router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    estimateFormController.getAllEstimateForms,
);

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN),
    estimateFormController.getEstimateFormById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateFormValidation.updateEstimateForm, ValidationProperty.BODY),
    estimateFormController.updateEstimateForm,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    estimateFormController.deleteEstimateForm,
);

router.patch(
    "/:id/toggle-published",
    checkAuth(UserRole.ADMIN),
    estimateFormController.togglePublished,
);

// ── Per-form submissions ──────────────────────────────────────────────────────

router.get(
    "/:id/submissions",
    checkAuth(UserRole.ADMIN),
    estimateFormController.getFormSubmissions,
);

export const estimateFormRoutes = router;
