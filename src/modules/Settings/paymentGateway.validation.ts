import { z } from "zod";

const updatePaymentGatewaySchema = z
  .object({
    // ── Stripe ──────────────────────────────────────────────────────
    stripeEnabled: z.boolean().optional(),
    stripePublishableKey: z.string().optional(),
    stripeSecretKey: z.string().optional(), // raw → masked in service
    stripeWebhookSecret: z.string().optional(), // raw → masked in service
    stripeTestMode: z.boolean().optional(),

    // ── PayPal ──────────────────────────────────────────────────────
    paypalEnabled: z.boolean().optional(),
    paypalClientId: z.string().optional(),
    paypalClientSecret: z.string().optional(), // raw → masked in service
    paypalTestMode: z.boolean().optional(),

    // ── Payment link & receipt settings ─────────────────────────────
    invoicePaymentLink: z.boolean().optional(),
    quotePaymentLink: z.boolean().optional(),
    autoSendReceipt: z.boolean().optional(),
  })
  .strict();

export const paymentGatewayValidation = {
  update: updatePaymentGatewaySchema,
};
