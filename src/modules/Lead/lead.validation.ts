import z from "zod";

const phone = z.string().trim()
    .regex(/^[+\d\s()\-.]{7,40}$/, "Invalid phone number")
    .refine((value) => {
        const digits = value.replace(/\D/g, "");
        return digits.length >= 7 && digits.length <= 20;
    }, "Invalid phone number");

const createLeadSchema = z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),
    phone: phone.optional(),
    serviceInterest: z.string().min(1, "Service interest is required"),
    estimatedMin: z.number().min(0).optional().default(0),
    estimatedMax: z.number().min(0).optional().default(0),
    notes: z.string().optional(),
    sourceRef: z.string().optional(),
    serviceCatalogId: z.string().uuid().optional(),
});

const updateLeadSchema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: phone.optional(),
    serviceInterest: z.string().min(1).optional(),
    estimatedMin: z.number().min(0).optional(),
    estimatedMax: z.number().min(0).optional(),
    notes: z.string().optional(),
    sourceRef: z.string().optional(),
    serviceCatalogId: z.string().uuid().optional(),
});

const updateLeadStageSchema = z.object({
    stage: z.enum([
        "NEW", "CONTACTED", "QUOTE_SENT", "WON", "LOST",
        "New", "Contacted", "Quote Sent", "Won", "Lost",
    ]),
});


export const leadValidation = {
    createLead: createLeadSchema,
    updateLead: updateLeadSchema,
    updateLeadStage: updateLeadStageSchema,
};
