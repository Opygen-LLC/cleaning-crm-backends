import { z } from "zod";
import { FormFieldType, FormSubmissionStatus, ServiceType } from "../../generated/prisma/enums";

// ── Shared helpers ────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isoDateSchema = z
    .string()
    .regex(ISO_DATE_RE, "Date must be in YYYY-MM-DD format")
    .refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }, "Date is invalid");

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const serviceSchema = z.object({
    serviceCatalogId: z.string().uuid().optional(),
    serviceType: z.enum(ServiceType).optional(),
    enabled:     z.boolean().optional(),
    priceLabel:  z.string().trim().max(120).optional(),
    duration:    z.string().trim().max(120).optional(),
}).strict().superRefine((value, ctx) => {
    if (!value.serviceCatalogId && !value.serviceType) {
        ctx.addIssue({ code: "custom", path: ["serviceCatalogId"], message: "Choose a service" });
    }
});

const fieldSchema = z.object({
    type:        z.enum(FormFieldType),
    label:       z.string().trim().min(1).max(120),
    placeholder: z.string().max(250).optional(),
    required:    z.boolean().optional(),
    enabled:     z.boolean().optional(),
    options:     z.array(z.string().trim().min(1).max(250)).max(100).optional(),
    sortOrder:   z.number().int().min(0).optional(),
}).strict();

// ── Create / Update ────────────────────────────────────────────────────────────

export const createBookingFormSchema = z.object({
    headline:            z.string().trim().min(1, "Headline is required").max(180),
    subheading:          z.string().max(500).optional(),
    accentColor:         z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    showReviews:         z.boolean().optional(),
    ctaLabel:            z.string().max(80).optional(),
    confirmationMessage: z.string().max(1000).optional(),
    availableDays:       z.array(z.string()).max(7).optional(),
    blockedDates:        z.array(z.string()).max(1000).optional(),
    timeSlots:           z.array(z.string()).max(200).optional(),
    maxBookingsPerSlot:  z.number().int().min(1).max(50).optional(),
    slotDurationMinutes: z.number().int().min(15).max(480).optional(),
    bufferTimeMinutes:   z.number().int().min(0).max(120).optional(),
    services:            z.array(serviceSchema).max(50).optional(),
    fields:              z.array(fieldSchema).max(100).optional(),
}).strict();

export const updateBookingFormSchema = createBookingFormSchema
    .omit({ headline: true })
    .extend({
        headline:  z.string().trim().min(1).max(180).optional(),
        published: z.boolean().optional(),
    })
    .partial();

// ── Public booking ─────────────────────────────────────────────────────────────

const publicAnswersSchema = z
    .record(z.string().trim().min(1).max(100), z.string().trim().max(3000))
    .refine((answers) => Object.keys(answers).length <= 50, {
        message: "Too many custom field answers",
    });

export const publicBookingSubmissionSchema = z.object({
    serviceCatalogId: z.string().uuid().optional(),
    serviceType: z.enum(ServiceType).optional(),
    date:        isoDateSchema,
    timeSlot:    z.string().regex(TIME_RE, "Time must be in HH:MM format"),
    name:        z.string().trim().min(1, "Full name is required").max(120),
    email:       z.string().trim().email("Enter a valid email address").max(254),
    phone:       z.string().trim()
        .regex(/^[+\d\s()\-.]{7,40}$/, "Enter a valid phone number")
        .refine((value) => {
            const digits = value.replace(/\D/g, "");
            return digits.length >= 7 && digits.length <= 20;
        }, "Enter a valid phone number"),
    address:     z.string().trim().min(3, "Service address is required").max(500),
    propertyType: z.enum(["HOUSE", "FLAT", "OFFICE", "COMMERCIAL", "OTHER"]).optional(),
    bedrooms:    z.number().int().min(0).max(50).optional(),
    bathrooms:   z.number().int().min(0).max(50).optional(),
    notes:       z.string().trim().max(2000).optional(),
    answers:     publicAnswersSchema.optional(),
    utmSource:   z.string().trim().max(120).optional(),
    utmCampaign: z.string().trim().max(160).optional(),
}).strict().superRefine((value, ctx) => {
    if (!value.serviceCatalogId && !value.serviceType) {
        ctx.addIssue({ code: "custom", path: ["serviceCatalogId"], message: "Choose a service" });
    }
    if ((value.propertyType === "HOUSE" || value.propertyType === "FLAT") && value.bedrooms === undefined) {
        ctx.addIssue({ code: "custom", path: ["bedrooms"], message: "Choose the number of bedrooms" });
    }
    if ((value.propertyType === "HOUSE" || value.propertyType === "FLAT") && value.bathrooms === undefined) {
        ctx.addIssue({ code: "custom", path: ["bathrooms"], message: "Choose the number of bathrooms" });
    }
});

export const publicSlotAvailabilityQuerySchema = z.object({
    date: isoDateSchema,
}).strict();

// ── Submission status update ───────────────────────────────────────────────────

export const updateSubmissionStatusSchema = z.object({
    status: z.enum(FormSubmissionStatus),
}).strict();

export const bookingFormValidation = {
    createBookingFormSchema,
    updateBookingFormSchema,
    publicBookingSubmissionSchema,
    publicSlotAvailabilityQuerySchema,
    updateSubmissionStatusSchema,
};
