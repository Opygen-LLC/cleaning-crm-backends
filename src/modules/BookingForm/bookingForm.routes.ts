import { Router } from "express";
import { bookingFormController } from "./bookingForm.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  zodValidate,
  ValidationProperty,
} from "../../middlewares/validations/zodValidation.middleware";
import { bookingFormValidation } from "./bookingForm.validation";

const router = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────────

// GET  /api/v1/booking-form/public/:slug   — render public form
router.get("/public/:slug", bookingFormController.getPublicBookingForm);

// POST /api/v1/booking-form/public/:slug   — submit a booking request
router.post("/public/:slug", bookingFormController.submitPublicBookingForm);

// ── Protected routes (ADMIN only) ─────────────────────────────────────────────

router.use(checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN));

// GET    /api/v1/booking-form                — list all forms for admin
router.get("/", bookingFormController.getAllBookingForms);

// POST   /api/v1/booking-form                — create a new form
router.post(
  "/",
  zodValidate(
    bookingFormValidation.createBookingFormSchema,
    ValidationProperty.BODY,
  ),
  bookingFormController.createBookingForm,
);

// GET    /api/v1/booking-form/submissions    — all submissions (optionally ?formId=)
router.get("/submissions", bookingFormController.getSubmissions);

// PATCH  /api/v1/booking-form/submissions/:submissionId/status — update submission status
// NOTE: must be registered BEFORE /:id to prevent Express matching "submissions" as :id
router.patch(
  "/submissions/:submissionId/status",
  zodValidate(
    bookingFormValidation.updateSubmissionStatusSchema,
    ValidationProperty.BODY,
  ),
  bookingFormController.updateSubmissionStatus,
);

// GET    /api/v1/booking-form/:id            — get single form
router.get("/:id", bookingFormController.getBookingFormById);

// PATCH  /api/v1/booking-form/:id            — update form config / fields / services
router.patch(
  "/:id",
  zodValidate(
    bookingFormValidation.updateBookingFormSchema,
    ValidationProperty.BODY,
  ),
  bookingFormController.updateBookingForm,
);

// DELETE /api/v1/booking-form/:id            — delete form
router.delete("/:id", bookingFormController.deleteBookingForm);

// PATCH  /api/v1/booking-form/:id/publish    — toggle published
router.patch("/:id/publish", bookingFormController.togglePublished);

// GET    /api/v1/booking-form/:id/submissions — submissions for a specific form
router.get("/:id/submissions", bookingFormController.getFormSubmissions);

export const bookingFormRoutes = router;
