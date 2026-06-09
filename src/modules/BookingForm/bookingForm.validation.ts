import { z } from "zod";
import { FormFieldType, FormSubmissionStatus, ServiceType } from "../../generated/prisma/enums";

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const serviceSchema = z.object({
    serviceType: z.enum(ServiceType),
    enabled:     z.boolean().optional(),
    priceLabel:  z.string().optional(),
    duration:    z.string().optional(),
}).strict();

const fieldSchema = z.object({
    type:        z.enum(FormFieldType),
    label:       z.string().min(1),
    placeholder: z.string().optional(),
    required:    z.boolean().optional(),
    enabled:     z.boolean().optional(),
    options:     z.array(z.string()).optional(),
    sortOrder:   z.number().int().min(0).optional(),
}).strict();

// ── Create / Update ────────────────────────────────────────────────────────────

export const createBookingFormSchema = z.object({
    headline:            z.string().min(1, "Headline is required"),
    subheading:          z.string().optional(),
    accentColor:         z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    showReviews:         z.boolean().optional(),
    ctaLabel:            z.string().optional(),
    confirmationMessage: z.string().optional(),
    availableDays:       z.array(z.string()).optional(),
    blockedDates:        z.array(z.string()).optional(),
    timeSlots:           z.array(z.string()).optional(),
    maxBookingsPerSlot:  z.number().int().min(1).max(50).optional(),
    slotDurationMinutes: z.number().int().min(15).max(480).optional(),
    bufferTimeMinutes:   z.number().int().min(0).max(120).optional(),
    services:            z.array(serviceSchema).optional(),
    fields:              z.array(fieldSchema).optional(),
}).strict();

export const updateBookingFormSchema = createBookingFormSchema
    .omit({ headline: true })
    .extend({
        headline:  z.string().min(1).optional(),
        published: z.boolean().optional(),
    })
    .partial();

// ── Submission status update ───────────────────────────────────────────────────

export const updateSubmissionStatusSchema = z.object({
    status: z.enum(FormSubmissionStatus),
}).strict();

export const bookingFormValidation = {
    createBookingFormSchema,
    updateBookingFormSchema,
    updateSubmissionStatusSchema,
};
