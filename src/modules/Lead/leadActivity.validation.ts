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


const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format");

const getFollowUpsQuerySchema = z.object({
    date: dateKey.optional(),
    from: dateKey.optional(),
    to: dateKey.optional(),
    assignedTo: z.string().trim().min(1).max(128).optional(),
    status: z.enum(["PENDING", "COMPLETED", "CANCELLED", "ALL"]).optional(),
    scope: z.enum(["today", "overdue", "upcoming"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    sort: z.enum(["asc", "desc"]).optional(),
}).strict().superRefine((value, ctx) => {
    if (value.date && (value.from || value.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use date or from/to, not both", path: ["date"] });
    }
    if (value.from && value.to && value.from > value.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "from must be on or before to", path: ["from"] });
    }
});

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
    followUpsQuery: getFollowUpsQuerySchema,
};

export type LeadActivityTypeInput = (typeof leadActivityTypes)[number];
export type LeadActivityStatusInput = (typeof leadActivityStatuses)[number];
