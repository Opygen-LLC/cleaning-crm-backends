import { z } from "zod";
import { e164PhoneSchema } from "../../lib/validation/phone";
import { EstimateStatus } from "../../generated/prisma/enums";

// ── Shared sub-schemas ─────────────────────────────────────────────────────────

const lineItemSchema = z
    .object({
        description: z.string().min(1, "Description is required"),
        quantity: z.number().positive("Quantity must be positive"),
        unitPrice: z.number().min(0, "Unit price cannot be negative"),
        taxPercent: z.number().min(0).max(100).default(20),
        discountPercent: z.number().min(0).max(100).default(0),
    })
    .strict();

// ── Create ─────────────────────────────────────────────────────────────────────

const createEstimateSchema = z
    .object({
        clientId: z.string().uuid("Invalid client ID").optional(),
        newClient: z.object({
            name: z.string().trim().min(1, "Client name is required"),
            email: z.string().trim().email("Invalid client email"),
            phone: e164PhoneSchema(),
            addressLine1: z.string().trim().min(1, "Client address is required"),
            city: z.string().trim().optional(),
            postcode: z.string().trim().optional(),
            country: z.string().trim().optional(),
        }).strict().optional(),
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
        serviceType: z.string().trim().min(1).optional(),
        address: z.string().min(1, "Address is required"),
        postcodeArea: z.string().optional(),
        estimatedDuration: z.string().optional(),
        numberOfCleaners: z.number().int().positive().optional(),
        lineItems: z
            .array(lineItemSchema)
            .min(1, "At least one line item is required"),
        discountType: z.enum(["percent", "fixed"]).default("percent"),
        discountValue: z.number().min(0).default(0),
        validUntil: z.string().datetime({ message: "Invalid ISO date string" }),
        notes: z.string().optional(),
        internalNotes: z.string().optional(),
        terms: z.string().optional(),
        deliveryIntent: z.enum(["DRAFT", "PUBLISH", "SEND"]).default("DRAFT"),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (Boolean(value.clientId) === Boolean(value.newClient)) {
            ctx.addIssue({
                code: "custom",
                path: [value.clientId ? "newClient" : "clientId"],
                message: "Choose exactly one client mode: existing client or new client",
            });
        }
        if (!value.serviceCatalogId && !value.serviceType) {
            ctx.addIssue({
                code: "custom",
                path: ["serviceCatalogId"],
                message: "Choose a service",
            });
        }
    });

// ── Update ─────────────────────────────────────────────────────────────────────

const updateEstimateSchema = z
    .object({
        serviceCatalogId: z.string().uuid("Invalid service catalog ID").nullable().optional(),
        serviceType: z.string().trim().min(1).optional(),
        address: z.string().min(1).optional(),
        postcodeArea: z.string().optional(),
        estimatedDuration: z.string().optional(),
        numberOfCleaners: z.number().int().positive().optional(),
        lineItems: z.array(lineItemSchema).min(1).optional(),
        discountType: z.enum(["percent", "fixed"]).optional(),
        discountValue: z.number().min(0).optional(),
        validUntil: z.string().datetime().optional(),
        notes: z.string().optional(),
        internalNotes: z.string().optional(),
        terms: z.string().optional(),
    })
    .strict();

// ── Status ─────────────────────────────────────────────────────────────────────

const updateStatusSchema = z
    .object({
        status: z.enum(EstimateStatus),
    })
    .strict();

const publicEstimateActionSchema = z
    .object({
        action: z.enum(["approve", "reject"]),
        note: z.string().trim().max(2000).optional(),
    })
    .strict();

// ── Convert to Booking ─────────────────────────────────────────────────────────

const convertToBookingSchema = z
    .object({
        scheduledDate: z
            .string()
            .datetime({ message: "Invalid ISO date string" }),
        durationMins: z.number().int().positive("Duration must be positive"),
        staffIds: z.array(z.string().uuid("Invalid staff ID")).optional(),
        notes: z.string().optional(),
    })
    .strict();

// ── Convert to Quote ────────────────────────────────────────────────────────────

const convertToQuoteSchema = z
    .object({
        validUntil: z.string().datetime({ message: "Invalid ISO date string" }),
        notes: z.string().optional(),
        internalNotes: z.string().optional(),
    })
    .strict();

// ── Export ─────────────────────────────────────────────────────────────────────

export const estimateValidation = {
    createEstimate: createEstimateSchema,
    updateEstimate: updateEstimateSchema,
    updateStatus: updateStatusSchema,
    publicEstimateAction: publicEstimateActionSchema,
    convertToBooking: convertToBookingSchema,
    convertToQuote: convertToQuoteSchema,
};
