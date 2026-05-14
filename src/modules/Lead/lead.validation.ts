import z from "zod";

const createLeadSchema = z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),
    phone: z.string().optional(),
    serviceInterest: z.string().min(1, "Service interest is required"),
    estimatedMin: z.number().min(0).optional().default(0),
    estimatedMax: z.number().min(0).optional().default(0),
    notes: z.string().optional(),
    sourceRef: z.string().optional(),
});

const updateLeadSchema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    serviceInterest: z.string().min(1).optional(),
    estimatedMin: z.number().min(0).optional(),
    estimatedMax: z.number().min(0).optional(),
    notes: z.string().optional(),
    sourceRef: z.string().optional(),
});

const updateLeadStageSchema = z.object({
    stage: z.enum(["NEW", "CONTACTED", "QUOTE_SENT", "WON", "LOST"]),
});

export const leadValidation = {
    createLead: createLeadSchema,
    updateLead: updateLeadSchema,
    updateLeadStage: updateLeadStageSchema,
};
