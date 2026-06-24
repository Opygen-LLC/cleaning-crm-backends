/**
 * staff.routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Production-ready route file that combines:
 *
 *  STAFF self-service routes  (must precede /:id so "me" isn't treated as an ID)
 *    GET    /staff/me              — own profile + availability + perf summary
 *    PATCH  /staff/me              — update name, phone, address, emergency
 *    POST   /staff/me/avatar       — upload photo to Cloudinary (multipart)
 *
 *  STAFF leave routes  (kept here so the frontend's /staff/leave/* URLs work
 *                        without remounting at /staff-leave/)
 *    POST   /staff/leave           — request leave (fires Socket.IO to admin)
 *    GET    /staff/leave           — own leave list
 *    GET    /staff/leave/all       — admin: all leaves  ← must be before /:id
 *    DELETE /staff/leave/:id       — cancel pending leave
 *    PATCH  /staff/leave/:id/review — admin approve/decline
 *
 *  ADMIN CRUD routes
 *    POST   /staff/                — create staff member
 *    GET    /staff/                — list own staff
 *    GET    /staff/:id             — fetch single staff
 *    PATCH  /staff/:id             — update staff
 *    PUT    /staff/:id/availability — update availability slots
 *    DELETE /staff/:id             — delete staff
 *
 * IMPORTANT — In routes/index.ts:
 *   • Change the /staff-leave mount to use /staff:
 *       { path: "/staff", route: staffLeaveRoutes }
 *   • OR (preferred) remove staffLeaveRoutes from gatedRoutes entirely and
 *     keep everything in this one staffRoutes file via the staffLeaveController
 *     imports below. This file uses the second approach.
 */

import { Router } from "express";
import { staffController } from "./staff.controller";
import { staffLeaveController } from "../StaffLeave/staffLeave.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { staffValidation } from "./staff.validation";
import { multerMemory } from "../../config/multerMemory";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// STAFF self-service  (no /:id params — must come first)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /staff/me — own profile + availability + performance summary */
router.get("/me", checkAuth(UserRole.STAFF), staffController.getMyProfile);

/** PATCH /staff/me — update personal details (name, phone, address, emergency) */
router.patch("/me", checkAuth(UserRole.STAFF), staffController.updateMyProfile);

/**
 * POST /staff/me/avatar
 * Upload profile photo (multipart/form-data, field name: "avatar").
 * Streams buffer to Cloudinary, saves secure_url → user.image.
 */
router.post(
  "/me/avatar",
  checkAuth(UserRole.STAFF),
  multerMemory.single("avatar"),
  staffController.uploadMyAvatar,
);

// ─────────────────────────────────────────────────────────────────────────────
// STAFF leave  (must come before /:id routes)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /staff/leave/all — admin sees all leave requests (before /:id!) */
router.get(
  "/leave/all",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  staffLeaveController.getStaffLeaves,
);

/** POST /staff/leave — staff submits a leave request; fires Socket.IO to admin */
router.post(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.requestLeave,
);

/** GET /staff/leave — staff views own leave requests */
router.get(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.getMyLeaves,
);

/** DELETE /staff/leave/:id — staff cancels a PENDING leave; fires Socket.IO to admin */
router.delete(
  "/leave/:id",
  checkAuth(UserRole.STAFF),
  staffLeaveController.cancelLeave,
);

/** PATCH /staff/leave/:id/review — admin approves or declines; fires Socket.IO to staff */
router.patch(
  "/leave/:id/review",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  staffLeaveController.reviewLeave,
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CRUD
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/",
  checkAuth(UserRole.ADMIN),
  zodValidate(staffValidation.createStaff, ValidationProperty.BODY),
  staffController.createStaff,
);

router.get("/", checkAuth(UserRole.ADMIN), staffController.getMyStaff);

router.get("/:id", checkAuth(UserRole.ADMIN), staffController.getStaffById);

router.patch(
  "/:id",
  checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
  zodValidate(staffValidation.updateStaff, ValidationProperty.BODY),
  staffController.updateStaff,
);

router.put(
  "/:id/availability",
  checkAuth(UserRole.ADMIN),
  zodValidate(staffValidation.updateAvailability, ValidationProperty.BODY),
  staffController.updateAvailability,
);

router.delete(
  "/:id",
  checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN),
  staffController.deleteStaff,
);

export const staffRoutes = router;
