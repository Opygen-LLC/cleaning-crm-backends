import { Router } from "express";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { sessionController } from "./session.controller";

const router = Router();

router.get(
    "/my-session",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    sessionController.geMySession,
);

router.delete(
    "/my-session/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    sessionController.deleteMySession,
);

export const sessionRoutes = router;
