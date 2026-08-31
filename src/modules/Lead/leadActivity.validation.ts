import { z } from "zod";

export const leadActivityTypes = [
    "CALL",
    "EMAIL",
    "FOLLOW_UP",
    "MEETING",
    "NOTE",
    "REMINDER",
] as const;

export const leadActivityStatuses = ["PENDING", "COMPLETED", "CANCELLED"] as const;

const createLeadActivitySchema = z
    .object({
        type: z.enum(leadActivityTypes),
        status: z.enum(leadActivityStatuses).optional().default("PENDING"),
        scheduledAt: z.string().datetime({ message: "Invalid scheduled date" }).optional(),
        assignedToUserId: z.string().min(1).nullable().optional(),
        note: z.string().trim().max(5000, "Note cannot exceed 5000 characters").optional(),
        outcome: z.string().trim().max(5000, "Outcome cannot exceed 5000 characters").optional(),
    })
    .strict();

const updateLeadActivitySchema = z
    .object({
        type: z.enum(leadActivityTypes).optional(),
        status: z.enum(leadActivityStatuses).optional(),
        scheduledAt: z.string().datetime({ message: "Invalid scheduled date" }).nullable().optional(),
        assignedToUserId: z.string().min(1).nullable().optional(),
        note: z.string().trim().max(5000, "Note cannot exceed 5000 characters").nullable().optional(),
        outcome: z.string().trim().max(5000, "Outcome cannot exceed 5000 characters").nullable().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one activity field to update",
    });

export const leadActivityValidation = {
    create: createLeadActivitySchema,
    update: updateLeadActivitySchema,
};

export type LeadActivityTypeInput = (typeof leadActivityTypes)[number];
export type LeadActivityStatusInput = (typeof leadActivityStatuses)[number];
