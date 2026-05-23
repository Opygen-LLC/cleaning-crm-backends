import { Router } from "express";
import { recurringBookingController } from "./recurringBooking.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { recurringBookingValidation } from "./recurringBooking.validation";

const router = Router();

// Stats (before /:id so Express doesn't treat "stats" as an id param)
router.get(
    "/stats",
    checkAuth(UserRole.ADMIN),
    recurringBookingController.getScheduleStats,
);

// CRUD
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(recurringBookingValidation.createSchedule, ValidationProperty.BODY),
    recurringBookingController.createSchedule,
);

router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    recurringBookingController.getAllSchedules,
);

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN),
    recurringBookingController.getScheduleById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(recurringBookingValidation.updateSchedule, ValidationProperty.BODY),
    recurringBookingController.updateSchedule,
);

// pause / resume / cancel
router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN),
    zodValidate(recurringBookingValidation.statusAction, ValidationProperty.BODY),
    recurringBookingController.updateScheduleStatus,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    recurringBookingController.deleteSchedule,
);

// Manually trigger booking generation for a schedule
router.post(
    "/:id/generate",
    checkAuth(UserRole.ADMIN),
    recurringBookingController.generateNextBooking,
);

export const recurringBookingRoutes = router;
