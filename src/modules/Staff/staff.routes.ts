/**
 * src/modules/Staff/staff.routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Router for staff profile, availability, and admin CRUD endpoints.
 *
 * Leave-domain endpoints are intentionally owned only by
 * StaffLeave/staffLeave.routes.ts and mounted at the same /staff prefix.
 * Keeping ownership separate prevents route shadowing and duplicate policy gates.
 *
 * Endpoints:
 *
 *  STAFF SELF-SERVICE
 *   GET    /staff/me              own profile + availability + perf stats
 *   PATCH  /staff/me              update name, phone, address, emergency contact
 *   POST   /staff/me/avatar       upload profile photo → Cloudinary (multipart)
 *   PATCH  /staff/me/availability toggle/edit own weekly working-hours schedule
 *
 *  ADMIN CRUD
 *   POST   /staff/                create staff member
 *   GET    /staff/                list own staff (paginated, searchable)
 *   GET    /staff/:id             single staff record
 *   PATCH  /staff/:id             update staff (admin only; STAFF uses /staff/me)
 *   PUT    /staff/:id/availability update availability slots
 *   POST   /staff/:id/reset-password admin resets staff member's password
 *   DELETE /staff/:id             soft-delete staff
 */

import { Router } from "express";
import { staffController } from "./staff.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { staffValidation } from "./staff.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

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

/** PATCH /staff/:id — admin-only record update; STAFF must use /staff/me. */
router.patch(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN),
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
