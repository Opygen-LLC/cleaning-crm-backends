import { Router } from "express";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { staffLeaveController } from "./staffLeave.controller";

const router = Router();

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

export const staffLeaveRoutes = router;
