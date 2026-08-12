/**
 * job.routes.ts — Phase 1 Production Version
 *
 * Changes vs original:
 *   • checkFeature("auto-dispatch") added to dispatch routes so PRO-only
 *     feature is enforced at the API layer, not just the FE gate.
 *   • All other routes unchanged — attachments, notes, checkin/checkout
 *     are already wired in the original.
 */

import { Router } from "express";
import { jobController } from "./job.controller";
import { jobDispatchController } from "./job.dispatch.controller";
import { jobNotesController } from "./job.notes.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { jobValidation } from "./job.validation";
import { jobNotesValidation } from "./job.notes.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get("/stats", checkAuth(UserRole.ADMIN), jobController.getJobStats);

// ── Map data (Phase 2 — location-aware dispatch) ───────────────────────────────
// Must stay above "/:id" so "/map-data" isn't swallowed as a job id param.
router.get("/map-data", checkAuth(UserRole.ADMIN), jobController.getMapData);

// ── Staff availability ────────────────────────────────────────────────────────
router.get(
    "/staff-availability",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.staffAvailability, ValidationProperty.QUERY),
    jobController.getStaffAvailability,
);

// ── Bulk auto-dispatch (PRO feature gate) ─────────────────────────────────────
router.post(
    "/dispatch/bulk",
    checkAuth(UserRole.ADMIN),
    checkFeature("auto-dispatch"),
    jobDispatchController.bulkDispatch,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.createJob, ValidationProperty.BODY),
    jobController.createJob,
);
router.get("/", checkAuth(UserRole.ADMIN, UserRole.STAFF), jobController.getAllJobs);
router.get("/:id", checkAuth(UserRole.ADMIN, UserRole.STAFF), jobController.getJobById);
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
router.delete("/:id", checkAuth(UserRole.ADMIN), jobController.deleteJob);

// ── Booking → Job conversion ──────────────────────────────────────────────────
router.post("/from-booking/:bookingId", checkAuth(UserRole.ADMIN), jobController.convertBookingToJob);

// ── Staff Assignment ──────────────────────────────────────────────────────────
router.put(
    "/:id/staff",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobValidation.assignStaff, ValidationProperty.BODY),
    jobController.assignStaff,
);

// ── Auto-dispatch single job (PRO feature gate) ───────────────────────────────
router.get("/:id/dispatch", checkAuth(UserRole.ADMIN), checkFeature("auto-dispatch"), jobDispatchController.getRecommendations);
router.post("/:id/dispatch", checkAuth(UserRole.ADMIN), checkFeature("auto-dispatch"), jobDispatchController.dispatchJob);

// ── Job Notes ─────────────────────────────────────────────────────────────────
router.get(
    "/:id/notes",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    zodValidate(jobNotesValidation.getNotesQuery, ValidationProperty.QUERY),
    jobNotesController.getNotes,
);
router.post(
    "/:id/notes",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    zodValidate(jobNotesValidation.createNote, ValidationProperty.BODY),
    jobNotesController.createNote,
);
router.patch(
    "/:id/notes/:noteId",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobNotesValidation.updateNote, ValidationProperty.BODY),
    jobNotesController.updateNote,
);
router.delete("/:id/notes/:noteId", checkAuth(UserRole.ADMIN), jobNotesController.deleteNote);

// ── Check-in / Check-out ──────────────────────────────────────────────────────
router.post("/:id/checkin", checkAuth(UserRole.STAFF, UserRole.ADMIN), jobController.checkIn);
router.post("/:id/checkout", checkAuth(UserRole.STAFF, UserRole.ADMIN), jobController.checkOut);

// ── Job Attachments ───────────────────────────────────────────────────────────
router.get("/:id/attachments", checkAuth(UserRole.ADMIN, UserRole.STAFF), jobNotesController.getAttachments);
router.post(
    "/:id/attachments",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    multerMemory.single("file"),
    convertHeicToPng,
    jobNotesController.uploadAttachment,
);
router.delete("/:id/attachments/:attachId", checkAuth(UserRole.ADMIN), jobNotesController.deleteAttachment);

export const jobRoutes = router;
