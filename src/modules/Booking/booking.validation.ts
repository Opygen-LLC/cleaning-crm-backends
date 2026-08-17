import { z } from "zod";
import { BookingStatus, ServiceType } from "../../generated/prisma/enums";
import { normalizePhone } from "../../lib/utils/normalizePhone";

// ── Create ────────────────────────────────────────────────────────────────────

const createBookingSchema = z
    .object({
        // Either reference an existing client…
        clientId:      z.string().uuid("Invalid client ID").optional(),
        // …or supply the details for a brand-new lead so one can be created
        // in the same request (e.g. converting an Online Booking / Estimate
        // Form submission that hasn't been added as a client yet).
        clientName:    z.string().min(1, "Client name is required").optional(),
        clientEmail:   z.string().email("Invalid email address").optional(),
        // S6 — accept the same flexible formats the frontend allows
        // (spaces, dashes, parens, a leading "+"), then normalize to
        // digits-only (+ leading "+") before it ever reaches the DB, so
        // "07700 900100" and "(07700) 900-100" are stored identically.
        clientPhone:   z
            .string()
            .min(1, "Client phone is required")
            .regex(/^[+\d\s\-()]+$/, "Invalid phone number")
            .transform(normalizePhone)
            .optional(),
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
        serviceType:   z.enum(ServiceType).optional(),
        address:       z.string().min(1, "Address is required"),
        scheduledDate: z.string().datetime({ message: "Invalid ISO date string" }),
        durationMins:  z.number().int().positive("Duration must be positive"),
        total:         z.number().positive("Total must be positive"),
        notes:         z.string().optional(),
        quoteId:       z.string().uuid("Invalid quote ID").optional(),
        staffIds:      z.array(z.string().uuid("Invalid staff ID")).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (!data.serviceCatalogId && !data.serviceType) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Choose a service",
                path: ["serviceCatalogId"],
            });
        }
        if (data.clientId) return;

        const missing: string[] = [];
        if (!data.clientName) missing.push("clientName");
        if (!data.clientEmail) missing.push("clientEmail");
        if (!data.clientPhone) missing.push("clientPhone");

        if (missing.length) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "Provide either clientId, or clientName + clientEmail + clientPhone to create a new lead",
                path: [missing[0]],
            });
        }
    });


const convertBookingSubmissionSchema = z.object({
    scheduledDate: z.string().datetime({ message: "Invalid ISO date string" }),
    durationMins: z.number().int().positive("Duration must be positive"),
    total: z.number().positive("Total must be positive"),
    notes: z.string().trim().max(2000).optional(),
    staffIds: z.array(z.string().uuid("Invalid staff ID")).max(50).optional(),
}).strict();

// ── Update ────────────────────────────────────────────────────────────────────

const updateBookingSchema = z
    .object({
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
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
    convertBookingSubmission: convertBookingSubmissionSchema,
    updateBooking:  updateBookingSchema,
    updateStatus:   updateStatusSchema,
    assignStaff:    assignStaffSchema,
    calendarQuery:  calendarQuerySchema,
};
