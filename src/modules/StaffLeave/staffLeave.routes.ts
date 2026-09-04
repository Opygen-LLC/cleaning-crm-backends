/**
 * Authoritative leave-domain router.
 *
 * Mounted at `/staff` in routes/index.ts, so this module alone owns:
 *   POST   /staff/leave
 *   GET    /staff/leave
 *   DELETE /staff/leave/:id
 *   GET    /staff/leave/all
 *   PATCH  /staff/leave/:id/review
 *
 * Staff/staff.routes.ts intentionally contains no leave handlers. Keeping all
 * leave authorization and feature gating here prevents route shadowing and
 * policy drift between duplicate implementations.
 */

import { Router } from "express";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import { staffLeaveController } from "./staffLeave.controller";

const router = Router();
const hasLeaveApprovals = checkFeature("leave_approvals");

router.post(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.requestLeave,
);

router.get(
  "/leave",
  checkAuth(UserRole.STAFF),
  staffLeaveController.getMyLeaves,
);

router.delete(
  "/leave/:id",
  checkAuth(UserRole.STAFF),
  staffLeaveController.cancelLeave,
);

// Keep the static `/all` route registered before any future generic leave-id
// GET route so Express never interprets `all` as an identifier.
router.get(
  "/leave/all",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  hasLeaveApprovals,
  staffLeaveController.getStaffLeaves,
);

router.patch(
  "/leave/:id/review",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  hasLeaveApprovals,
  staffLeaveController.reviewLeave,
);

export const staffLeaveRoutes = router;
