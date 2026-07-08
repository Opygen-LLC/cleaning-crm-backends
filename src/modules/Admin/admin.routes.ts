import { Router } from "express";
import { adminController } from "./admin.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { adminValidation } from "./admin.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { multerUpload } from "../../config/multer";

const router = Router();

router.get("/profile", checkAuth(UserRole.ADMIN), adminController.getAdmin);

router.patch(
    "/profile",
    checkAuth(UserRole.ADMIN),
    multerUpload.single("businessLogo"),
    zodValidate(adminValidation.updateAdmin, ValidationProperty.BODY),
    adminController.updateAdmin,
);

router.patch(
    "/work-location/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(adminValidation.updateWorkLocation, ValidationProperty.BODY),
    adminController.updateWorkLocation,
);

router.delete(
    "/work-location/:id",
    checkAuth(UserRole.ADMIN),
    adminController.deleteWorkLocation,
);

// GET /api/v1/admin/usage — returns staffCount, clientCount, bookingCountThisMonth
router.get("/usage", checkAuth(UserRole.ADMIN), adminController.getAdminUsage);

// GET /api/v1/admin/onboarding-status — guided setup wizard progress (auto-detected)
router.get(
    "/onboarding-status",
    checkAuth(UserRole.ADMIN),
    adminController.getOnboardingStatus,
);

export const adminRoutes = router;
