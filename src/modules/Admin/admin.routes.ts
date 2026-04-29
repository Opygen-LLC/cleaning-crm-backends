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

router.patch(
    "/profile",
    checkAuth(UserRole.ADMIN),
    multerUpload.single("businessLogo"),
    zodValidate(adminValidation.updateAdmin, ValidationProperty.BODY),
    adminController.updateAdmin,
);

export const adminRoutes = router;
