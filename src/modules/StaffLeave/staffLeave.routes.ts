import { Router } from "express";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { staffLeaveController } from "./staffLeave.controller";

const router = Router();

// ── Staff endpoints ────────────────────────────────────────────────────────────

// Staff: submit a leave request
router.post(
    "/leave",
    checkAuth(UserRole.STAFF),
    staffLeaveController.requestLeave,
);

// Staff: view own leave requests
router.get(
    "/leave",
    checkAuth(UserRole.STAFF),
    staffLeaveController.getMyLeaves,
);

// Staff: cancel a pending leave request
router.delete(
    "/leave/:id",
    checkAuth(UserRole.STAFF),
    staffLeaveController.cancelLeave,
);

// ── Admin endpoints ────────────────────────────────────────────────────────────

// Admin: view all staff leave requests (filterable by status / staffId)
router.get(
    "/leave/all",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    staffLeaveController.getStaffLeaves,
);

// Admin: approve or decline a leave request
router.patch(
    "/leave/:id/review",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    staffLeaveController.reviewLeave,
);

export const staffLeaveRoutes = router;
