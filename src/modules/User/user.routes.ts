import { Router } from "express";
import { userController } from "./user.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { userValidation } from "./user.validation";
import { multerUpload } from "../../config/multer";

const router = Router();

// Get own profile
router.get(
    "/me", 
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF), 
    userController.getMe
);

// Get all users (Super Admin only)
router.get(
    "/",
    checkAuth(UserRole.SUPER_ADMIN),
    userController.getAllUsers
);

// Manage User routes
router.get(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    userController.getUserById
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.STAFF, UserRole.SUPER_ADMIN),
    multerUpload.single("image"),
    zodValidate(userValidation.updateUser, ValidationProperty.BODY),
    userController.updateUser,
);

export const userRoutes = router;