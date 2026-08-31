import { z } from "zod";
import { optionalE164PhoneSchema } from "../../lib/validation/phone";
import { QuoteStatus } from "../../generated/prisma/enums";

const lineItemSchema = z.object({
    description: z.string().min(1, "Description is required"),
    quantity: z.number().int().positive("Quantity must be a positive integer"),
    unitPrice: z.number().positive("Unit price must be positive"),
}).strict();

const serviceIdentityFields = {
    serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
    serviceType: z.string().trim().min(1).optional(),
};

const requireService = <T extends { serviceCatalogId?: string; serviceType?: string }>(value: T, ctx: z.RefinementCtx) => {
    if (!value.serviceCatalogId && !value.serviceType) {
        ctx.addIssue({ code: "custom", path: ["serviceCatalogId"], message: "Choose a service" });
    }
};

const createQuoteSchema = z.object({
    clientId: z.string().uuid("Invalid client ID").optional(),
    clientName: z.string().trim().min(1, "Client name is required").optional(),
    clientEmail: z.string().trim().email("Invalid email address").optional(),
    clientPhone: optionalE164PhoneSchema(),
    ...serviceIdentityFields,
    address: z.string().min(1, "Address is required"),
    lineItems: z.array(lineItemSchema).min(1, "At least one line item is required"),
    taxRate: z.number().min(0).max(100),
    validUntil: z.string().datetime({ message: "Invalid ISO date string" }),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    templateId: z.string().uuid().optional(),
}).strict().superRefine((data, ctx) => {
    requireService(data, ctx);
    if (data.clientId) return;
    const missing: string[] = [];
    if (!data.clientName) missing.push("clientName");
    if (!data.clientEmail) missing.push("clientEmail");
    if (missing.length) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either clientId, or clientName and clientEmail to create a new client",
            path: [missing[0]],
        });
    }
});

const updateQuoteSchema = z.object({
    serviceCatalogId: z.string().uuid("Invalid service catalog ID").nullable().optional(),
    serviceType: z.string().trim().min(1).optional(),
    address: z.string().min(1).optional(),
    lineItems: z.array(lineItemSchema).min(1).optional(),
    taxRate: z.number().min(0).max(100).optional(),
    validUntil: z.string().datetime().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
}).strict();

const updateStatusSchema = z.object({ status: z.enum(QuoteStatus) }).strict();

const convertToBookingSchema = z.object({
    scheduledDate: z.string().datetime({ message: "Invalid ISO date string" }),
    durationMins: z.number().int().positive("Duration must be positive"),
    staffIds: z.array(z.string().uuid("Invalid staff ID")).optional(),
    notes: z.string().optional(),
}).strict();

const convertToJobSchema = convertToBookingSchema;

const publicQuoteActionSchema = z.object({
    action: z.enum(["accept", "decline"]),
    note: z.string().trim().max(1000, "Response note cannot exceed 1000 characters").optional(),
}).strict();

const templateLineItemSchema = lineItemSchema;

const createTemplateSchema = z.object({
    name: z.string().min(1, "Template name is required"),
    ...serviceIdentityFields,
    taxRate: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
    lineItems: z.array(templateLineItemSchema).min(1, "At least one line item is required"),
}).strict().superRefine(requireService);

const updateTemplateSchema = z.object({
    name: z.string().min(1).optional(),
    serviceCatalogId: z.string().uuid("Invalid service catalog ID").nullable().optional(),
    serviceType: z.string().trim().min(1).optional(),
    taxRate: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
    lineItems: z.array(templateLineItemSchema).min(1).optional(),
}).strict();

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
