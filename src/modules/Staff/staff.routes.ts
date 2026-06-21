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
    checkAuth(UserRole.ADMIN),
    zodValidate(staffValidation.createStaff, ValidationProperty.BODY),
    staffController.createStaff
);

// Get my staff (Admin only)
router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    staffController.getMyStaff
);

// Get staff by id (Admin only)
router.get(
    "/:id",
    checkAuth(UserRole.ADMIN),
    staffController.getStaffById
);

// Update staff profile fields (staffRole, mobileNumber)
router.patch(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    zodValidate(staffValidation.updateStaff, ValidationProperty.BODY),
    staffController.updateStaff,
);

// Replace all 7 availability slots for a staff member (Admin only)
router.put(
    "/:id/availability",
    checkAuth(UserRole.ADMIN),
    zodValidate(staffValidation.updateAvailability, ValidationProperty.BODY),
    staffController.updateAvailability,
);

router.delete(
    "/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN),
    staffController.deleteStaff,
);

export const staffRoutes = router;
