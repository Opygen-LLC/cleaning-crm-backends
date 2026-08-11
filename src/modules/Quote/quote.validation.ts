import { z } from "zod";
import { QuoteStatus } from "../../generated/prisma/enums";

// ── Shared sub-schemas ─────────────────────────────────────────────────────────

const lineItemSchema = z
    .object({
        description: z.string().min(1, "Description is required"),
        quantity: z
            .number()
            .int()
            .positive("Quantity must be a positive integer"),
        unitPrice: z.number().positive("Unit price must be positive"),
    })
    .strict();

// ── Create ─────────────────────────────────────────────────────────────────────

const createQuoteSchema = z
    .object({
        clientId: z.string().uuid("Invalid client ID"),
        serviceType: z.string().min(1, "Service type is required"),
        address: z.string().min(1, "Address is required"),
        lineItems: z
            .array(lineItemSchema)
            .min(1, "At least one line item is required"),
        taxRate: z
            .number()
            .min(0, "Tax rate cannot be negative")
            .max(100, "Tax rate cannot exceed 100"),
        validUntil: z.string().datetime({ message: "Invalid ISO date string" }),
        notes: z.string().optional(),
        internalNotes: z.string().optional(),
        templateId: z.string().uuid().optional(),
    })
    .strict();

// ── Update ─────────────────────────────────────────────────────────────────────

const updateQuoteSchema = z
    .object({
        serviceType: z.string().min(1).optional(),
        address: z.string().min(1).optional(),
        lineItems: z.array(lineItemSchema).min(1).optional(),
        taxRate: z.number().min(0).max(100).optional(),
        validUntil: z.string().datetime().optional(),
        notes: z.string().optional(),
        internalNotes: z.string().optional(),
    })
    .strict();

// ── Status ─────────────────────────────────────────────────────────────────────

const updateStatusSchema = z
    .object({
        status: z.enum(QuoteStatus),
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

// ── Convert to Job ─────────────────────────────────────────────────────────────

const convertToJobSchema = z
    .object({
        scheduledDate: z
            .string()
            .datetime({ message: "Invalid ISO date string" }),
        durationMins: z.number().int().positive("Duration must be positive"),
        staffIds: z.array(z.string().uuid("Invalid staff ID")).optional(),
        notes: z.string().optional(),
    })
    .strict();

// ── Public action (unauthenticated) ───────────────────────────────────────────

const publicQuoteActionSchema = z
    .object({
        action: z.enum(["accept", "decline"]),
    })
    .strict();

// ── Quote Templates ────────────────────────────────────────────────────────────

const templateLineItemSchema = z
    .object({
        description: z.string().min(1, "Description is required"),
        quantity: z
            .number()
            .int()
            .positive("Quantity must be a positive integer"),
        unitPrice: z.number().positive("Unit price must be positive"),
    })
    .strict();

const createTemplateSchema = z
    .object({
        name: z.string().min(1, "Template name is required"),
        serviceType: z.string().min(1, "Service type is required"),
        taxRate: z.number().min(0).max(100).optional(),
        notes: z.string().optional(),
        lineItems: z
            .array(templateLineItemSchema)
            .min(1, "At least one line item is required"),
    })
    .strict();

const updateTemplateSchema = z
    .object({
        name: z.string().min(1).optional(),
        serviceType: z.string().min(1).optional(),
        taxRate: z.number().min(0).max(100).optional(),
        notes: z.string().optional(),
        lineItems: z.array(templateLineItemSchema).min(1).optional(),
    })
    .strict();

// ── Export ─────────────────────────────────────────────────────────────────────

export const quoteValidation = {
    createQuote: createQuoteSchema,
    updateQuote: updateQuoteSchema,
    updateStatus: updateStatusSchema,
    convertToBooking: convertToBookingSchema,
    convertToJob: convertToJobSchema,
    publicQuoteAction: publicQuoteActionSchema,
    createTemplate: createTemplateSchema,
    updateTemplate: updateTemplateSchema,
};
