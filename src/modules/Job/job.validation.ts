import { z } from "zod";
import { JobStatus, ServiceType } from "../../generated/prisma/enums";

// ── Create ────────────────────────────────────────────────────────────────────

const createJobSchema = z
    .object({
        clientId:      z.string().uuid("Invalid client ID"),
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
        serviceType:   z.enum(ServiceType).optional(),
        address:       z.string().min(1, "Address is required"),
        scheduledDate: z.string().datetime({ message: "Invalid ISO date string" }),
        durationMins:  z.number().int().positive("Duration must be positive"),
        notes:         z.string().optional(),
        quoteId:       z.string().uuid("Invalid quote ID").optional(),
        estimateId:    z.string().uuid("Invalid estimate ID").optional(),
        bookingId:     z.string().uuid("Invalid booking ID").optional(),
        staffIds:      z.array(z.string().uuid("Invalid staff ID")).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (!data.bookingId && !data.serviceCatalogId && !data.serviceType) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serviceCatalogId"], message: "Choose a service" });
        }
    });

// ── Update ────────────────────────────────────────────────────────────────────

const updateJobSchema = z
    .object({
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
        serviceType:   z.enum(ServiceType).optional(),
        address:       z.string().min(1).optional(),
        scheduledDate: z.string().datetime().optional(),
        durationMins:  z.number().int().positive().optional(),
        notes:         z.string().optional(),
    })
    .strict();

// ── Status ────────────────────────────────────────────────────────────────────

const updateStatusSchema = z
    .object({
        status: z.enum(JobStatus),
    })
    .strict();

// ── Staff assignment ──────────────────────────────────────────────────────────

const assignStaffSchema = z
    .object({
        // allow empty array to remove all assignments
        staffIds: z.array(z.string().uuid("Invalid staff ID")),
    })
    .strict();

// ── Staff availability query ──────────────────────────────────────────────────

const staffAvailabilitySchema = z
    .object({
        date:         z.string().datetime({ message: "Invalid ISO date string" }),
        durationMins: z.string().regex(/^\d+$/, "Must be a positive integer"),
    })
    .strict();

export const jobValidation = {
    createJob:         createJobSchema,
    updateJob:         updateJobSchema,
    updateStatus:      updateStatusSchema,
    assignStaff:       assignStaffSchema,
    staffAvailability: staffAvailabilitySchema,
};
