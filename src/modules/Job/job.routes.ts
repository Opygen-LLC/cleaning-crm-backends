import { Router } from "express";
import { jobController } from "./job.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { jobValidation } from "./job.validation";

const router = Router();

// ── Stats (before /:id so Express doesn't treat "stats" as an id param) ───────

router.get(
    "/stats",
    checkAuth(UserRole.ADMIN),
    jobController.getJobStats,
);

// ── Staff availability ────────────────────────────────────────────────────────

router.get(
    "/staff-availability",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.staffAvailability, ValidationProperty.QUERY),
    jobController.getStaffAvailability,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.createJob, ValidationProperty.BODY),
    jobController.createJob,
);

router.get(
    "/",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    jobController.getAllJobs,
);

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    jobController.getJobById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.updateJob, ValidationProperty.BODY),
    jobController.updateJob,
);

router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    zodValidate(jobValidation.updateStatus, ValidationProperty.BODY),
    jobController.updateJobStatus,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    jobController.deleteJob,
);

// ── Booking → Job conversion ──────────────────────────────────────────────────

router.post(
    "/from-booking/:bookingId",
    checkAuth(UserRole.ADMIN),
    jobController.convertBookingToJob,
);

// ── Staff Assignment ──────────────────────────────────────────────────────────

router.put(
    "/:id/staff",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.assignStaff, ValidationProperty.BODY),
    jobController.assignStaff,
);

export const jobRoutes = router;
