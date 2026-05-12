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

router.get(
    "/notifications",
    checkAuth(UserRole.ADMIN),
    notificationController.getPrefs,
);

router.patch(
    "/notifications",
    checkAuth(UserRole.ADMIN),
    zodValidate(notificationValidation.updatePrefs, ValidationProperty.BODY),
    notificationController.updatePrefs,
);

export const notificationRoutes = router;
