import { Router } from "express";
import { staffController } from "./staff.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { staffValidation } from "./staff.validation";

const router = Router();

// Create staff member
router.post(
    "/",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(staffValidation.createStaff, ValidationProperty.BODY),
    staffController.createStaff
);

// Get own profile
router.get(
    "/me", 
    checkAuth(UserRole.STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN), 
    staffController.getMyProfile
);

// Get all staff (Super Admin sees all, Admin/Staff see within their company context)
router.get(
    "/", 
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF), 
    staffController.getAllStaff
);

// Get specific staff
router.get(
    "/:id", 
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF), 
    staffController.getStaffById
);

// Manage Staff
router.patch(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    zodValidate(staffValidation.updateStaff, ValidationProperty.BODY),
    staffController.updateStaff,
);

router.delete(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN),
    staffController.deleteStaff,
);

export const staffRoutes = router;
