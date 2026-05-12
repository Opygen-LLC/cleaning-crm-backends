import { z } from "zod";
import { BookingStatus, ServiceType } from "../../generated/prisma/enums";

// ── Create ────────────────────────────────────────────────────────────────────

const createBookingSchema = z
    .object({
        clientId:      z.string().uuid("Invalid client ID"),
        serviceType:   z.enum(ServiceType),
        address:       z.string().min(1, "Address is required"),
        scheduledDate: z.string().datetime({ message: "Invalid ISO date string" }),
        durationMins:  z.number().int().positive("Duration must be positive"),
        total:         z.number().positive("Total must be positive"),
        notes:         z.string().optional(),
        quoteId:       z.string().uuid("Invalid quote ID").optional(),
        staffIds:      z.array(z.string().uuid("Invalid staff ID")).optional(),
    })
    .strict();

// ── Update ────────────────────────────────────────────────────────────────────

const updateBookingSchema = z
    .object({
        serviceType:   z.enum(ServiceType).optional(),
        address:       z.string().min(1).optional(),
        scheduledDate: z.string().datetime().optional(),
        durationMins:  z.number().int().positive().optional(),
        total:         z.number().positive().optional(),
        notes:         z.string().optional(),
    })
    .strict();

// ── Status ────────────────────────────────────────────────────────────────────

const updateStatusSchema = z
    .object({
        status: z.enum(BookingStatus),
    })
    .strict();

// ── Staff assignment ──────────────────────────────────────────────────────────

const assignStaffSchema = z
    .object({
        staffIds: z
            .array(z.string().uuid("Invalid staff ID"))
            .min(1, "At least one staff member is required"),
    })
    .strict();

// ── Calendar ─────────────────────────────────────────────────────────────────

const calendarQuerySchema = z
    .object({
        year:  z.string().regex(/^\d{4}$/, "Year must be 4 digits"),
        month: z.string().regex(/^([1-9]|1[0-2])$/, "Month must be 1-12"),
    })
    .strict();

export const bookingValidation = {
    createBooking:  createBookingSchema,
    updateBooking:  updateBookingSchema,
    updateStatus:   updateStatusSchema,
    assignStaff:    assignStaffSchema,
    calendarQuery:  calendarQuerySchema,
};
