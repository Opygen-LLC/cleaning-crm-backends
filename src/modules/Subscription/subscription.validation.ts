import { z } from "zod";
import { PaymentMethod } from "../../generated/prisma/enums";

const optionalTrimmed = (max: number) =>
    z.string().trim().max(max).optional().transform((value) => value || undefined);

const changePlanSchema = z.object({
    planId: z.string().uuid("Choose a valid subscription plan."),
    couponCode: optionalTrimmed(80),
}).strict();

const submitPaymentProofSchema = z.object({
    paymentProofUrl: z.string().url("Upload a valid payment proof first.").max(2000),
    // Phase-6 checkouts derive the amount on the server. `amount` remains
    // optional only for backward compatibility with pre-Phase-6 pending rows.
    amount: z.number().finite().positive().max(10_000_000).optional(),
    method: z.nativeEnum(PaymentMethod),
    note: optionalTrimmed(1000),
    transactionId: optionalTrimmed(200),
}).strict();

export const subscriptionValidation = {
    changePlanSchema,
    submitPaymentProofSchema,
};
