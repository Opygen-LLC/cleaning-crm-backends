import { z } from "zod";
import { ServiceType } from "../../generated/prisma/enums";

const serviceTypeValues = Object.values(ServiceType) as [ServiceType, ...ServiceType[]];

const pricingRuleSchema = z.object({
    id:              z.string().optional(),
    service:         z.enum(serviceTypeValues),
    baseRate:        z.number().min(0, "Base rate cannot be negative"),
    perRoomRate:     z.number().min(0, "Per-room rate cannot be negative"),
    minCharge:       z.number().min(0, "Min charge cannot be negative"),
    travelSurcharge: z.number().min(0, "Travel surcharge cannot be negative"),
});

const addOnRuleSchema = z.object({
    id:    z.string().optional(),
    label: z.string().min(1, "Add-on label is required"),
    price: z.number().min(0, "Price cannot be negative"),
});

const upsertPricingRulesSchema = z.object({
    rules:  z.array(pricingRuleSchema).min(1, "At least one pricing rule is required"),
    addons: z.array(addOnRuleSchema),
}).strict();

export const pricingRulesValidation = {
    upsertPricingRules: upsertPricingRulesSchema,
};
