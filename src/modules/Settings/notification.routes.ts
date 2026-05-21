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

router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    notificationController.getPrefs,
);

router.patch(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(notificationValidation.updatePrefs, ValidationProperty.BODY),
    notificationController.updatePrefs,
);

export const notificationRoutes = router;
