/**
 * staffLeave.routes.ts
 *
 * IMPORTANT — URL ARCHITECTURE NOTE
 * ──────────────────────────────────
 * The frontend staffDashboardApi calls:
 *   POST   /staff/leave          (requestLeave)
 *   GET    /staff/leave          (getMyLeaves)
 *   DELETE /staff/leave/:id      (cancelLeave)
 *   GET    /staff/leave/all      (getStaffLeaves)
 *   PATCH  /staff/leave/:id/review (reviewLeave)
 *
 * In routes/index.ts the staffLeaveRoutes are currently mounted at "/staff-leave",
 * making real paths like /staff-leave/leave — a mismatch.
 *
 * FIX: This file no longer prefixes its routes with /leave. Instead,
 * routes/index.ts must mount staffLeaveRoutes at "/staff" AFTER staffRoutes
 * (Express checks routes in order; Express router uses path matching, so
 * mounting two routers on "/staff" is fine — they don't collide because
 * the paths defined here start with /leave which no staffRoutes handler uses).
 *
 * Change in routes/index.ts (gatedRoutes array):
 *   { path: "/staff", route: staffRoutes },
 *   { path: "/staff", route: staffLeaveRoutes },   ← add this, remove the /staff-leave entry
 *
 * OR keep the existing staffLeaveRoutes mount and just update the frontend URLs
 * to match /staff-leave/leave. This file chooses the BACKEND FIX approach so
 * the frontend URLs don't need to change.
 */

import { Router } from "express";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { staffLeaveController } from "./staffLeave.controller";

const router = Router();

// ── Staff endpoints ────────────────────────────────────────────────────────────

// POST /staff/leave  — staff submits a leave request (fires socket to admin)
router.post(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.requestLeave,
);

// GET /staff/leave  — staff views own leave requests
router.get(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.getMyLeaves,
);

// DELETE /staff/leave/:id  — staff cancels a pending leave (fires socket to admin)
router.delete(
  "/leave/:id",
  checkAuth(UserRole.STAFF),
  staffLeaveController.cancelLeave,
);

// ── Admin endpoints ────────────────────────────────────────────────────────────

// GET /staff/leave/all  — admin views all leave requests (must be before /:id)
router.get(
  "/leave/all",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  staffLeaveController.getStaffLeaves,
);

// PATCH /staff/leave/:id/review  — admin approves or declines (fires socket to staff)
router.patch(
  "/leave/:id/review",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  staffLeaveController.reviewLeave,
);

export const staffLeaveRoutes = router;
