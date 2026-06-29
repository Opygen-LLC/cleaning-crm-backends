/**
 * recurringBooking.routes.ts
 *
 * CHANGE: Added checkFeature("recurring bookings") gate to all ADMIN
 * routes so the PRO-plan restriction is enforced at the API layer —
 * not just the FE FeatureGate wrapper. checkSubscription (status gate)
 * is applied at the router level in routes/index.ts.
 */

import { Router } from "express";
import { recurringBookingController } from "./recurringBooking.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { recurringBookingValidation } from "./recurringBooking.validation";

const router = Router();

const isAdmin         = checkAuth(UserRole.ADMIN);
const hasRecurring    = checkFeature("recurring bookings");

// Stats — gated
router.get(
    "/stats",
    isAdmin,
    hasRecurring,
    recurringBookingController.getScheduleStats,
);

// CRUD — all gated
router.post(
    "/",
    isAdmin,
    hasRecurring,
    zodValidate(recurringBookingValidation.createSchedule, ValidationProperty.BODY),
    recurringBookingController.createSchedule,
);

router.get(
    "/",
    isAdmin,
    hasRecurring,
    recurringBookingController.getAllSchedules,
);

router.get(
    "/:id",
    isAdmin,
    hasRecurring,
    recurringBookingController.getScheduleById,
);

router.patch(
    "/:id",
    isAdmin,
    hasRecurring,
    zodValidate(recurringBookingValidation.updateSchedule, ValidationProperty.BODY),
    recurringBookingController.updateSchedule,
);

// pause / resume / cancel
router.patch(
    "/:id/status",
    isAdmin,
    hasRecurring,
    zodValidate(recurringBookingValidation.statusAction, ValidationProperty.BODY),
    recurringBookingController.updateScheduleStatus,
);

router.delete(
    "/:id",
    isAdmin,
    hasRecurring,
    recurringBookingController.deleteSchedule,
);

// Manually trigger booking generation for a schedule
router.post(
    "/:id/generate",
    isAdmin,
    hasRecurring,
    recurringBookingController.generateNextBooking,
);

export const recurringBookingRoutes = router;
