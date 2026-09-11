import { z } from "zod";
import { PaymentMethod } from "../../generated/prisma/enums";

const optionalTrimmed = (max: number) =>
    z.string().trim().max(max).optional().transform((value) => value || undefined);

const changePlanSchema = z.object({
    planId: z.string().uuid("Choose a valid subscription plan."),
    couponCode: optionalTrimmed(80),
}).strict();

const submitPaymentProofSchema = z.object({
    paymentProofAssetId: z.string().uuid("Upload a valid payment proof first."),
    // Phase-6 checkouts derive the amount on the server. `amount` remains
    // optional only for backward compatibility with pre-Phase-6 pending rows.
    amount: z.number().finite().positive().max(10_000_000).optional(),
    method: z.nativeEnum(PaymentMethod),
    note: optionalTrimmed(1000),
    transactionId: optionalTrimmed(200),
}).strict();

const proofUploadInitiateSchema = z.object({
    filename: z.string().trim().min(1, "Choose a file to upload.").max(255),
    contentType: z.string().trim().min(3).max(100).transform((value) => value.toLowerCase()),
    size: z.number().int().positive().max(100 * 1024 * 1024),
}).strict();

const proofUploadParamsSchema = z.object({
    uploadId: z.string().uuid("Choose a valid subscription proof upload."),
}).strict();



const billingHistoryQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const subscriptionValidation = {
    changePlanSchema,
    submitPaymentProofSchema,
    proofUploadInitiateSchema,
    proofUploadParamsSchema,
    billingHistoryQuerySchema,
};
