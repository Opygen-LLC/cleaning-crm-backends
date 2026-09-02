import z from "zod";
import { optionalE164PhoneSchema } from "../../lib/validation/phone";

const phone = optionalE164PhoneSchema();

const createLeadSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone,
  serviceInterest: z.string().min(1, "Service interest is required"),
  estimatedMin: z.number().min(0).optional().default(0),
  estimatedMax: z.number().min(0).optional().default(0),
  notes: z.string().optional(),
  sourceRef: z.string().optional(),
  serviceCatalogId: z.string().uuid().optional(),
  stage: z
    .enum(["NEW", "CONTACTED", "QUOTE_SENT", "WON", "LOST"])
    .optional()
    .default("NEW"),
  initialFollowUp: z
    .object({
      scheduledAt: z.string().datetime({ message: "Invalid follow-up date" }),
      assignedToUserId: z.string().min(1).optional(),
      note: z
        .string()
        .trim()
        .max(5000, "Follow-up note cannot exceed 5000 characters")
        .optional(),
    })
    .strict()
    .optional(),
});

const updateLeadSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone,
  serviceInterest: z.string().min(1).optional(),
  estimatedMin: z.number().min(0).optional(),
  estimatedMax: z.number().min(0).optional(),
  notes: z.string().optional(),
  sourceRef: z.string().optional(),
  serviceCatalogId: z.string().uuid().optional(),
});

const updateLeadStageSchema = z.object({
  stage: z.enum([
    "NEW",
    "CONTACTED",
    "QUOTE_SENT",
    "WON",
    "LOST",
    "New",
    "Contacted",
    "Quote Sent",
    "Won",
    "Lost",
  ]),
});

export const leadValidation = {
  createLead: createLeadSchema,
  updateLead: updateLeadSchema,
  updateLeadStage: updateLeadStageSchema,
};
