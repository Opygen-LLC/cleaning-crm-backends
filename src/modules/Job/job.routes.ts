/**
 * job.routes.ts  (updated — Phase 1 complete)
 *
 * Changes vs original:
 *  1. Added  GET  /job/:id/dispatch  — ranked recommendations (dry-run)
 *  2. Added  POST /job/:id/dispatch  — commit auto-assign for one job
 *  3. Added  POST /job/dispatch/bulk — commit auto-assign all unassigned jobs
 *
 * Socket.IO integration is handled inside job.service.ts (updateJobStatus)
 * and job.dispatch.service.ts (dispatchJob / bulkDispatch) via emitToAdmin().
 * No route change is needed for real-time — it piggybacks existing PATCH /:id/status.
 */

import { Router } from "express";
import { jobController } from "./job.controller";
import { jobDispatchController } from "./job.dispatch.controller";
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

// ── [NEW] Bulk auto-dispatch (before /:id to avoid Express id collision) ──────

router.post(
    "/dispatch/bulk",
    checkAuth(UserRole.ADMIN),
    jobDispatchController.bulkDispatch,
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

// ── [NEW] Auto-dispatch (single job) ─────────────────────────────────────────

router.get(
    "/:id/dispatch",
    checkAuth(UserRole.ADMIN),
    jobDispatchController.getRecommendations,
);

router.post(
    "/:id/dispatch",
    checkAuth(UserRole.ADMIN),
    jobDispatchController.dispatchJob,
);

export const jobRoutes = router;
