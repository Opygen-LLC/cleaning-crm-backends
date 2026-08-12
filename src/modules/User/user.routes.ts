import { Router } from "express";
import { userController } from "./user.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { userValidation } from "./user.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

// Get own profile
router.get(
    "/me",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    userController.getMe,
);

/**
 * POST /user/me/avatar
 * Multipart upload (field: "avatar") → Cloudinary → user.image updated.
 * Registered before "/:id" so "me" is never treated as a route param.
 * Mirrors POST /staff/me/avatar for the Staff role.
 */
router.post(
    "/me/avatar",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    multerMemory.single("avatar"),
    convertHeicToPng,
    userController.uploadMyAvatar,
);

// Get all users (Super Admin only)
router.get("/", checkAuth(UserRole.SUPER_ADMIN), userController.getAllUsers);

// Manage User routes
router.get(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    userController.getUserById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.STAFF, UserRole.SUPER_ADMIN),
    multerMemory.single("image"),
    convertHeicToPng,
    zodValidate(userValidation.updateUser, ValidationProperty.BODY),
    userController.updateUser,
);

export const userRoutes = router;
