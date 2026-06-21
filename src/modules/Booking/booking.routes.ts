import { Router } from "express";
import { bookingController } from "./booking.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { bookingValidation } from "./booking.validation";

const router = Router();

// ── Calendar (must be registered BEFORE /:id to prevent shadowing) ───────────
// Express matches routes in registration order. GET /calendar/view would be
// caught by GET /:id (with id="calendar") if registered after it.

router.get(
    "/calendar/view",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    zodValidate(bookingValidation.calendarQuery, ValidationProperty.QUERY),
    bookingController.getCalendarView,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(bookingValidation.createBooking, ValidationProperty.BODY),
    bookingController.createBooking,
);

router.get(
    "/",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    bookingController.getAllBookings,
);

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    bookingController.getBookingById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(bookingValidation.updateBooking, ValidationProperty.BODY),
    bookingController.updateBooking,
);

router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN, UserRole.STAFF),
    zodValidate(bookingValidation.updateStatus, ValidationProperty.BODY),
    bookingController.updateBookingStatus,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    bookingController.deleteBooking,
);

// ── Staff Assignment ──────────────────────────────────────────────────────────

router.put(
    "/:id/staff",
    checkAuth(UserRole.ADMIN),
    zodValidate(bookingValidation.assignStaff, ValidationProperty.BODY),
    bookingController.assignStaff,
);

export const bookingRoutes = router;
