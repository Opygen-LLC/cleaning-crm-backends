import { Router } from "express";
import { notificationController } from "./notification.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { notificationValidation } from "./notification.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// Mounted at /notification in routes/index.ts
// Full paths: GET /api/v1/notification  |  PATCH /api/v1/notification
// (removed the nested /notifications segment to avoid /notification/notifications double-path)

router.get("/", checkAuth(UserRole.ADMIN), notificationController.getPrefs);

router.patch(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(notificationValidation.updatePrefs, ValidationProperty.BODY),
    notificationController.updatePrefs,
);

// ─── Item 18: In-app notification inbox endpoints ─────────────────────────────
// GET  /api/v1/notification/inbox          — fetch latest 50 notifications
// PATCH /api/v1/notification/:id/read      — mark one as read
// PATCH /api/v1/notification/read-all      — mark all as read
//
// Note: /read-all must be registered BEFORE /:id/read so Express doesn't
// interpret "read-all" as an :id param.

router.get(
    "/inbox",
    checkAuth(UserRole.ADMIN),
    notificationController.getInbox,
);

router.patch(
    "/read-all",
    checkAuth(UserRole.ADMIN),
    notificationController.markAllRead,
);

router.patch(
    "/:id/read",
    checkAuth(UserRole.ADMIN),
    notificationController.markRead,
);

export const notificationRoutes = router;
