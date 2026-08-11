/**
 * src/modules/Staff/staff.routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single router that owns the entire /staff/* namespace.
 *
 * Route order matters — Express matches in registration order:
 *   1. Static "me" paths first  → /me, /me/avatar, /leave/all, /leave, /leave/:id
 *   2. Admin CRUD paths last    → /, /:id, /:id/availability
 *
 * Endpoints:
 *
 *  STAFF SELF-SERVICE
 *   GET    /staff/me              own profile + availability + perf stats
 *   PATCH  /staff/me              update name, phone, address, emergency contact
 *   POST   /staff/me/avatar       upload profile photo → Cloudinary (multipart)
 *   PATCH  /staff/me/availability toggle/edit own weekly working-hours schedule
 *
 *  LEAVE (staff submits / admin reviews)
 *   POST   /staff/leave           request leave  → emitToAdmin("leave:requested")
 *   GET    /staff/leave           own leave list
 *   GET    /staff/leave/all       admin: all leaves (must be before /:id)
 *   DELETE /staff/leave/:id       cancel pending → emitToAdmin("leave:cancelled")
 *   PATCH  /staff/leave/:id/review admin approve/decline → emitToStaff("leave:reviewed")
 *
 *  ADMIN CRUD
 *   POST   /staff/                create staff member
 *   GET    /staff/                list own staff (paginated, searchable)
 *   GET    /staff/:id             single staff record
 *   PATCH  /staff/:id             update staff (admin or staff can call)
 *   PUT    /staff/:id/availability update availability slots
 *   POST   /staff/:id/reset-password admin resets staff member's password
 *   DELETE /staff/:id             soft-delete staff
 */

import { Router } from "express";
import { staffController } from "./staff.controller";
import { staffLeaveController } from "../StaffLeave/staffLeave.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { staffValidation } from "./staff.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

// GATES.teamLeaveApprovals ("leave approvals") gates the admin-facing leave
// endpoints only. NOTE: this router is registered before StaffLeave/
// staffLeave.routes.ts at the same "/staff" mount in routes/index.ts, so
// these handlers — not the ones in staffLeave.routes.ts — are the ones that
// actually serve /staff/leave/all and /staff/leave/:id/review.
const hasLeaveApprovals = checkFeature("leave approvals");

// ─── STAFF SELF-SERVICE ───────────────────────────────────────────────────────
// These must be registered before /:id so "me" is never treated as a MongoDB/UUID id.

/** GET /staff/me — own profile + availability + performance summary */
router.get("/me", checkAuth(UserRole.STAFF), staffController.getMyProfile);

/** PATCH /staff/me — update personal details */
router.patch("/me", checkAuth(UserRole.STAFF), staffController.updateMyProfile);

/**
 * POST /staff/me/avatar
 * Multipart upload (field: "avatar") → HEIC conversion → Cloudinary → user.image updated.
 * Returns { avatarUrl: string } pointing to the Cloudinary secure URL.
 * File size limit: 10 MB (set by multerMemory config).
 * convertHeicToPng is a no-op for jpeg/png so it is always safe to include.
 */
router.post(
    "/me/avatar",
    checkAuth(UserRole.STAFF),
    multerMemory.single("avatar"),
    convertHeicToPng,
    staffController.uploadMyAvatar,
);

/**
 * PATCH /staff/me/availability
 * Staff member toggles/edits their own weekly working-hours schedule.
 * Body: { availability: StaffAvailabilityInput[] } — all 7 days required,
 * same validation as the admin PUT /:id/availability route below.
 */
router.patch(
    "/me/availability",
    checkAuth(UserRole.STAFF),
    zodValidate(staffValidation.updateAvailability, ValidationProperty.BODY),
    staffController.updateMyAvailability,
);

// ─── LEAVE ROUTES ─────────────────────────────────────────────────────────────
// /leave/all must be registered BEFORE /leave/:id to avoid "all" being parsed as an ID.

/** GET /staff/leave/all — admin sees all pending/approved/declined leaves */
router.get(
    "/leave/all",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    hasLeaveApprovals,
    staffLeaveController.getStaffLeaves,
);

/** POST /staff/leave — staff submits a new leave request */
router.post(
    "/leave",
    checkAuth(UserRole.STAFF),
    staffLeaveController.requestLeave,
);

/** GET /staff/leave — staff views their own leave requests */
router.get(
    "/leave",
    checkAuth(UserRole.STAFF),
    staffLeaveController.getMyLeaves,
);

/** DELETE /staff/leave/:id — staff cancels a PENDING leave */
router.delete(
    "/leave/:id",
    checkAuth(UserRole.STAFF),
    staffLeaveController.cancelLeave,
);

/**
 * PATCH /staff/leave/:id/review
 * Admin approves or declines. Body: { decision: "APPROVED"|"DECLINED", adminNote?: string }
 * Fires Socket.IO "leave:reviewed" to staff member's room on success.
 */
router.patch(
    "/leave/:id/review",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    hasLeaveApprovals,
    staffLeaveController.reviewLeave,
);

// ─── ADMIN CRUD ───────────────────────────────────────────────────────────────

/** POST /staff/ — admin creates a new staff member */
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(staffValidation.createStaff, ValidationProperty.BODY),
    staffController.createStaff,
);

/** GET /staff/ — admin lists all their staff members */
router.get("/", checkAuth(UserRole.ADMIN), staffController.getMyStaff);

/** GET /staff/:id — admin fetches a single staff record */
router.get("/:id", checkAuth(UserRole.ADMIN), staffController.getStaffById);

/** PATCH /staff/:id — admin or staff updates a record */
router.patch(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    zodValidate(staffValidation.updateStaff, ValidationProperty.BODY),
    staffController.updateStaff,
);

/**
 * PUT /staff/:id/availability
 * Admin updates working hours for a staff member.
 * Body: { availability: StaffAvailabilityInput[] }
 */
router.put(
    "/:id/availability",
    checkAuth(UserRole.ADMIN),
    zodValidate(staffValidation.updateAvailability, ValidationProperty.BODY),
    staffController.updateAvailability,
);

/**
 * POST /staff/:id/reset-password
 * Admin resets a staff member's password — generates a new random
 * password, emails it to them, forces a password change on next login,
 * and revokes their existing sessions. No request body required.
 */
router.post(
    "/:id/reset-password",
    checkAuth(UserRole.ADMIN),
    staffController.resetPassword,
);

/** DELETE /staff/:id — admin removes a staff member */
router.delete(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN),
    staffController.deleteStaff,
);

export const staffRoutes = router;
