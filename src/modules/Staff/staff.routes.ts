import { Router } from "express";
import { staffController } from "./staff.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { staffValidation } from "./staff.validation";
import { multerMemory } from "../../config/multerMemory";

const router = Router();

// ─── Staff self-service (MUST be before /:id to avoid Express treating
//     "me" as an id param) ────────────────────────────────────────────────────

/** GET  /staff/me — own profile + availability + perf summary */
router.get("/me", checkAuth(UserRole.STAFF), staffController.getMyProfile);

/** PATCH /staff/me — update name, phone, address, emergency contact */
router.patch("/me", checkAuth(UserRole.STAFF), staffController.updateMyProfile);

/** POST /staff/me/avatar — upload profile photo (multipart/form-data, field: "avatar") */
router.post(
  "/me/avatar",
  checkAuth(UserRole.STAFF),
  multerMemory.single("avatar"),
  staffController.uploadMyAvatar,
);

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

router.post(
  "/",
  checkAuth(UserRole.ADMIN),
  zodValidate(staffValidation.createStaff, ValidationProperty.BODY),
  staffController.createStaff,
);

router.get("/", checkAuth(UserRole.ADMIN), staffController.getMyStaff);

router.get("/:id", checkAuth(UserRole.ADMIN), staffController.getStaffById);

router.patch(
  "/:id",
  checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
  zodValidate(staffValidation.updateStaff, ValidationProperty.BODY),
  staffController.updateStaff,
);

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
