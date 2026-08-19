import { z } from "zod";

const pricingRuleSchema = z.object({
    id: z.string().optional(),
    serviceCatalogId: z.string().uuid("Choose a valid service"),
    serviceNameSnapshot: z.string().trim().min(1).max(160),
    baseRate: z.number().min(0, "Base rate cannot be negative"),
    perRoomRate: z.number().min(0, "Per-room rate cannot be negative"),
    minCharge: z.number().min(0, "Min charge cannot be negative"),
    travelSurcharge: z.number().min(0, "Travel surcharge cannot be negative"),
}).strict();

const addOnRuleSchema = z.object({
    id: z.string().optional(),
    label: z.string().trim().min(1, "Add-on label is required").max(160),
    price: z.number().min(0, "Price cannot be negative"),
}).strict();

const upsertPricingRulesSchema = z.object({
    rules: z.array(pricingRuleSchema),
    addons: z.array(addOnRuleSchema),
}).strict();

export const pricingRulesValidation = { upsertPricingRules: upsertPricingRulesSchema };
