import { z } from "zod";

// ── Nested sub-schemas (frontend sends these) ─────────────────────────────────

const stripeNestedSchema = z
    .object({
        enabled: z.boolean().optional(),
        publishableKey: z.string().optional(),
        /** Raw secret — never returned to client; service masks before storing */
        secretKey: z.string().optional(),
        /** Raw webhook secret — service masks before storing */
        webhookSecret: z.string().optional(),
        testMode: z.boolean().optional(),
    })
    .optional();

const paypalNestedSchema = z
    .object({
        enabled: z.boolean().optional(),
        clientId: z.string().optional(),
        /** Raw secret — service masks before storing */
        clientSecret: z.string().optional(),
        testMode: z.boolean().optional(),
    })
    .optional();

// ── Top-level update schema — accepts both nested (frontend) and flat shapes ──

const updatePaymentGatewaySchema = z.object({
    // ── Nested blocks (sent by the frontend) ────────────────────────────────────
    stripe: stripeNestedSchema,
    paypal: paypalNestedSchema,

    // ── Flat fields (legacy / direct API callers) ────────────────────────────────
    stripeEnabled: z.boolean().optional(),
    stripePublishableKey: z.string().optional(),
    stripeSecretKey: z.string().optional(),
    stripeWebhookSecret: z.string().optional(),
    stripeTestMode: z.boolean().optional(),
    paypalEnabled: z.boolean().optional(),
    paypalClientId: z.string().optional(),
    paypalClientSecret: z.string().optional(),
    paypalTestMode: z.boolean().optional(),

    // ── Shared settings ──────────────────────────────────────────────────────────
    activeGateway: z.string().optional(),
    invoicePaymentLink: z.boolean().optional(),
    quotePaymentLink: z.boolean().optional(),
    autoSendReceipt: z.boolean().optional(),
    defaultCurrency: z.string().max(10).optional(),
});

// ── OAuth connect ─────────────────────────────────────────────────────────────
const oauthConnectSchema = z.object({
    gateway: z.enum(["stripe", "paypal"]),
    code: z.string().min(1),
    scope: z.string().optional(),
});

// ── Disconnect ────────────────────────────────────────────────────────────────
const disconnectSchema = z.object({
    gateway: z.enum(["stripe", "paypal"]),
});

export const paymentGatewayValidation = {
    update: updatePaymentGatewaySchema,
    oauth: oauthConnectSchema,
    disconnect: disconnectSchema,
};
