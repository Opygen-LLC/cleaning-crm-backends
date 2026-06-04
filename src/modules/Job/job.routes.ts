/**
 * job.routes.ts  (updated — Phase 1 complete, production-ready)
 *
 * Changes vs previous version:
 *  1. [NEW] GET    /job/:id/notes                — list notes (pinned first)
 *  2. [NEW] POST   /job/:id/notes                — create a note
 *  3. [NEW] PATCH  /job/:id/notes/:noteId        — update / pin a note
 *  4. [NEW] DELETE /job/:id/notes/:noteId        — delete a note
 *  5. [NEW] GET    /job/:id/attachments          — list file attachments
 *  6. [NEW] POST   /job/:id/attachments          — upload a file (multipart)
 *  7. [NEW] DELETE /job/:id/attachments/:attachId — delete a file
 *
 * Calendar drag-reschedule was already handled by PATCH /:id (updateJob)
 * — the scheduledDate field is accepted there — no additional route needed.
 *
 * Socket.IO integration is handled inside job.service.ts (updateJobStatus)
 * and job.dispatch.service.ts (dispatchJob / bulkDispatch) via emitToAdmin().
 */

import { Router }              from "express";
import { jobController }       from "./job.controller";
import { jobDispatchController } from "./job.dispatch.controller";
import { jobNotesController }  from "./job.notes.controller";
import { checkAuth }           from "../../middlewares/checkAuth";
import { UserRole }            from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { jobValidation }       from "./job.validation";
import { jobNotesValidation }  from "./job.notes.validation";
import { multerMemory }        from "../../config/multerMemory";

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

// ── Auto-dispatch (single job) ────────────────────────────────────────────────

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

// ── [NEW] Job Notes ───────────────────────────────────────────────────────────

router.get(
    "/:id/notes",
    checkAuth(UserRole.ADMIN),
    jobNotesController.getNotes,
);

router.post(
    "/:id/notes",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobNotesValidation.createNote, ValidationProperty.BODY),
    jobNotesController.createNote,
);

router.patch(
    "/:id/notes/:noteId",
    checkAuth(UserRole.ADMIN),
    zodValidate(jobNotesValidation.updateNote, ValidationProperty.BODY),
    jobNotesController.updateNote,
);

router.delete(
    "/:id/notes/:noteId",
    checkAuth(UserRole.ADMIN),
    jobNotesController.deleteNote,
);

// ── [NEW] Job Attachments ─────────────────────────────────────────────────────

router.get(
    "/:id/attachments",
    checkAuth(UserRole.ADMIN),
    jobNotesController.getAttachments,
);

router.post(
    "/:id/attachments",
    checkAuth(UserRole.ADMIN),
    // memoryStorage so we can pass the buffer to Cloudinary's upload_stream
    multerMemory.single("file"),
    jobNotesController.uploadAttachment,
);

router.delete(
    "/:id/attachments/:attachId",
    checkAuth(UserRole.ADMIN),
    jobNotesController.deleteAttachment,
);

export const jobRoutes = router;
