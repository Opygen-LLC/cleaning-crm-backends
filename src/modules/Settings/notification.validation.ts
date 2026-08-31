import { z } from "zod";

const updateNotificationPrefsSchema = z
    .object({
        emailNewBooking:       z.boolean().optional(),
        emailBookingCancelled: z.boolean().optional(),
        emailBookingReminder:  z.boolean().optional(),
        emailBookingDayOfReminder: z.boolean().optional(),
        emailQuoteAccepted:    z.boolean().optional(),
        emailQuoteDeclined:    z.boolean().optional(),
        emailInvoicePaid:      z.boolean().optional(),
        emailInvoiceOverdue:   z.boolean().optional(),
        emailNewClient:        z.boolean().optional(),
        emailStaffAssigned:    z.boolean().optional(),
        emailQuoteSent:        z.boolean().optional(),
        emailEstimateSent:     z.boolean().optional(),
        emailInvoiceSent:      z.boolean().optional(),
        emailReviewRequest:    z.boolean().optional(),
        emailWeeklySummary:    z.boolean().optional(),
        appNewBooking:         z.boolean().optional(),
        appJobStatusChange:    z.boolean().optional(),
        appQuoteUpdate:        z.boolean().optional(),
        appInvoiceUpdate:      z.boolean().optional(),
        appClientMessage:      z.boolean().optional(),
        smsBookingReminder:    z.boolean().optional(),
        smsJobAssigned:        z.boolean().optional(),
        reminderHoursBefore:   z.number().int().min(1).max(168).optional(),
        digestTime:            z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format").optional(),
    })
    .strict();

const upsertTemplateSchema = z.object({
    subject: z.string().trim().max(250).optional(),
    body: z.string().trim().min(1).max(10_000),
    channel: z.literal("EMAIL").optional(),
}).strict();

export const notificationValidation = {
    updatePrefs: updateNotificationPrefsSchema,
    upsertTemplate: upsertTemplateSchema,
};
