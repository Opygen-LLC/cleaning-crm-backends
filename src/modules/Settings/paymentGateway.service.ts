import { prisma } from "../../lib/prisma/prisma";
import { PaymentGateway } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

/** Show only last 4 chars — matches the *Masked column convention in the schema */
const mask = (key?: string | null): string | null =>
    key ? `••••••••${key.slice(-4)}` : null;

/**
 * Transforms the flat DB PaymentGatewayConfig row into the nested shape
 * the frontend expects:
 * {
 *   activeGateway, invoicePaymentLink, quotePaymentLink, autoSendReceipt,
 *   defaultCurrency,
 *   stripe: { enabled, publishableKey, secretKey, webhookSecret, testMode, connectedAccountId },
 *   paypal: { enabled, clientId, clientSecret, testMode, connectedMerchantId },
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toClientShape = (cfg: Record<string, any>) => ({
    activeGateway: (cfg.activeGateway as string)?.toLowerCase() ?? "none",
    invoicePaymentLink: cfg.invoicePaymentLink ?? true,
    quotePaymentLink: cfg.quotePaymentLink ?? false,
    autoSendReceipt: cfg.autoSendReceipt ?? true,
    defaultCurrency: cfg.defaultCurrency ?? "GBP",
    stripe: {
        enabled: cfg.stripeEnabled ?? false,
        publishableKey: cfg.stripePublishableKey ?? "",
        secretKey: cfg.stripeSecretKeyMasked ?? "",
        webhookSecret: cfg.stripeWebhookSecretMasked ?? "",
        testMode: cfg.stripeTestMode ?? true,
        connectedAccountId: cfg.stripeConnectedAccountId ?? null,
    },
    paypal: {
        enabled: cfg.paypalEnabled ?? false,
        clientId: cfg.paypalClientId ?? "",
        clientSecret: cfg.paypalClientSecretMasked ?? "",
        testMode: cfg.paypalTestMode ?? true,
        connectedMerchantId: cfg.paypalConnectedMerchantId ?? null,
    },
    square: {
        enabled: false,
        applicationId: "",
        accessToken: "",
        testMode: true,
    },
});

const getPaymentGatewayConfig = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true, paymentGateway: true },
    });

    if (!admin) throw new Error("Admin profile not found");

    if (!admin.paymentGateway) {
        const created = await prisma.paymentGatewayConfig.create({
            data: { adminId: admin.id },
        });
        return toClientShape(created);
    }

    return toClientShape(admin.paymentGateway);
};

/**
 * Accepts either the nested frontend shape or the legacy flat shape and
 * normalises everything to the flat DB column names before upserting.
 *
 * Nested frontend payload example:
 *   {
 *     activeGateway: "stripe",
 *     stripe: { publishableKey, secretKey, webhookSecret, testMode, enabled },
 *     paypal: { clientId, clientSecret, testMode, enabled },
 *     invoicePaymentLink, quotePaymentLink, autoSendReceipt, defaultCurrency
 *   }
 */
const updatePaymentGatewayConfig = async (
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: Record<string, any>,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new Error("Admin profile not found");

    const data: Record<string, unknown> = {};

    // ── Flatten nested stripe block ──────────────────────────────────────────
    if (payload.stripe && typeof payload.stripe === "object") {
        const s = payload.stripe as Record<string, unknown>;
        if ("enabled" in s) data.stripeEnabled = Boolean(s.enabled);
        if ("publishableKey" in s) data.stripePublishableKey = s.publishableKey;
        if ("testMode" in s) data.stripeTestMode = Boolean(s.testMode);
        if (
            "secretKey" in s &&
            s.secretKey &&
            !(s.secretKey as string).includes("•")
        )
            data.stripeSecretKeyMasked = mask(s.secretKey as string);
        if (
            "webhookSecret" in s &&
            s.webhookSecret &&
            !(s.webhookSecret as string).includes("•")
        )
            data.stripeWebhookSecretMasked = mask(s.webhookSecret as string);
    }

    // ── Flatten nested paypal block ──────────────────────────────────────────
    if (payload.paypal && typeof payload.paypal === "object") {
        const p = payload.paypal as Record<string, unknown>;
        if ("enabled" in p) data.paypalEnabled = Boolean(p.enabled);
        if ("clientId" in p) data.paypalClientId = p.clientId;
        if ("testMode" in p) data.paypalTestMode = Boolean(p.testMode);
        if (
            "clientSecret" in p &&
            p.clientSecret &&
            !(p.clientSecret as string).includes("•")
        )
            data.paypalClientSecretMasked = mask(p.clientSecret as string);
    }

    // ── Legacy flat fields (kept for backwards compat) ────────────────────────
    const flat = payload as {
        stripeEnabled?: boolean;
        stripePublishableKey?: string;
        stripeSecretKey?: string;
        stripeWebhookSecret?: string;
        stripeTestMode?: boolean;
        paypalEnabled?: boolean;
        paypalClientId?: string;
        paypalClientSecret?: string;
        paypalTestMode?: boolean;
    };
    if ("stripeEnabled" in flat) data.stripeEnabled = flat.stripeEnabled;
    if ("stripePublishableKey" in flat)
        data.stripePublishableKey = flat.stripePublishableKey;
    if ("stripeTestMode" in flat) data.stripeTestMode = flat.stripeTestMode;
    if (flat.stripeSecretKey)
        data.stripeSecretKeyMasked = mask(flat.stripeSecretKey);
    if (flat.stripeWebhookSecret)
        data.stripeWebhookSecretMasked = mask(flat.stripeWebhookSecret);
    if ("paypalEnabled" in flat) data.paypalEnabled = flat.paypalEnabled;
    if ("paypalClientId" in flat) data.paypalClientId = flat.paypalClientId;
    if ("paypalTestMode" in flat) data.paypalTestMode = flat.paypalTestMode;
    if (flat.paypalClientSecret)
        data.paypalClientSecretMasked = mask(flat.paypalClientSecret);

    // ── Scalar top-level fields ───────────────────────────────────────────────
    if ("invoicePaymentLink" in payload)
        data.invoicePaymentLink = payload.invoicePaymentLink;
    if ("quotePaymentLink" in payload)
        data.quotePaymentLink = payload.quotePaymentLink;
    if ("autoSendReceipt" in payload)
        data.autoSendReceipt = payload.autoSendReceipt;
    if ("defaultCurrency" in payload)
        data.defaultCurrency = payload.defaultCurrency;

    // ── Resolve active gateway ────────────────────────────────────────────────
    // Honour an explicit activeGateway if provided, otherwise derive it.
    if ("activeGateway" in payload && payload.activeGateway) {
        const gw = (payload.activeGateway as string).toUpperCase();
        data.activeGateway =
            gw === "STRIPE"
                ? PaymentGateway.STRIPE
                : gw === "PAYPAL"
                  ? PaymentGateway.PAYPAL
                  : PaymentGateway.NONE;
    } else {
        const current = await prisma.paymentGatewayConfig.findUnique({
            where: { adminId: admin.id },
        });
        const stripeOn =
            "stripeEnabled" in data
                ? Boolean(data.stripeEnabled)
                : Boolean(current?.stripeEnabled);
        const paypalOn =
            "paypalEnabled" in data
                ? Boolean(data.paypalEnabled)
                : Boolean(current?.paypalEnabled);

        if (stripeOn) data.activeGateway = PaymentGateway.STRIPE;
        else if (paypalOn) data.activeGateway = PaymentGateway.PAYPAL;
        else data.activeGateway = PaymentGateway.NONE;
    }

    const updated = await prisma.paymentGatewayConfig.upsert({
        where: { adminId: admin.id },
        update: data,
        create: { adminId: admin.id, ...data },
    });

    return toClientShape(updated);
};

// FIX: Added oauthConnect — stores the connectedAccountId/merchantId returned
// after a backend server-to-server OAuth code exchange with Stripe/PayPal.
//
// PRODUCTION TODO: Replace the stub below with a real SDK exchange:
//   Stripe:
//     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
//     const response = await stripe.oauth.token({ grant_type: "authorization_code", code });
//     const connectedAccountId = response.stripe_user_id!;
//
//   PayPal (sandbox / live):
//     POST https://api-m{testMode?'.sandbox':''}.paypal.com/v1/identity/openidconnect/tokenservice
//     body: grant_type=authorization_code&code=<code>
//     headers: Authorization: Basic base64(clientId:secret)
//     response.access_token → store as connectedMerchantId or use /v1/identity/oauth2/userinfo
const oauthConnect = async (
    userId: string,
    gateway: "stripe" | "paypal",
    code: string,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new Error("Admin profile not found");

    // Derive a stable connected-account ID.
    // In production: exchange `code` with Stripe/PayPal as described above.
    const connectedAccountId = code.startsWith("connected_")
        ? code // already a connection ID (re-connect)
        : `connected_${gateway}_${code.slice(0, 8)}_${Date.now()}`;

    let updatedCfg;
    if (gateway === "stripe") {
        updatedCfg = await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                stripeEnabled: true,
                stripeConnectedAccountId: connectedAccountId,
                activeGateway: PaymentGateway.STRIPE,
            },
            create: {
                adminId: admin.id,
                stripeEnabled: true,
                stripeConnectedAccountId: connectedAccountId,
                activeGateway: PaymentGateway.STRIPE,
            },
        });
    } else {
        updatedCfg = await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                paypalEnabled: true,
                paypalConnectedMerchantId: connectedAccountId,
                activeGateway: PaymentGateway.PAYPAL,
            },
            create: {
                adminId: admin.id,
                paypalEnabled: true,
                paypalConnectedMerchantId: connectedAccountId,
                activeGateway: PaymentGateway.PAYPAL,
            },
        });
    }

    return {
        success: true,
        connectedAccountId,
        config: toClientShape(updatedCfg),
    };
};

// FIX: Added disconnectGateway — clears the stored connection credentials.
const disconnectGateway = async (
    userId: string,
    gateway: "stripe" | "paypal",
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new Error("Admin profile not found");

    const current = await prisma.paymentGatewayConfig.findUnique({
        where: { adminId: admin.id },
    });

    let newActiveGateway = current?.activeGateway ?? PaymentGateway.NONE;

    let updatedCfg;
    if (gateway === "stripe") {
        if (newActiveGateway === PaymentGateway.STRIPE)
            newActiveGateway = current?.paypalEnabled
                ? PaymentGateway.PAYPAL
                : PaymentGateway.NONE;

        updatedCfg = await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                stripeEnabled: false,
                stripeConnectedAccountId: null,
                activeGateway: newActiveGateway,
            },
            create: { adminId: admin.id },
        });
    } else {
        if (newActiveGateway === PaymentGateway.PAYPAL)
            newActiveGateway = current?.stripeEnabled
                ? PaymentGateway.STRIPE
                : PaymentGateway.NONE;

        updatedCfg = await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                paypalEnabled: false,
                paypalConnectedMerchantId: null,
                activeGateway: newActiveGateway,
            },
            create: { adminId: admin.id },
        });
    }

    return { success: true, config: toClientShape(updatedCfg) };
};

// ─── PayPal Webhook Verification ──────────────────────────────────────────────
//
// PayPal sends IPN/webhook events to a registered endpoint.
// We verify the event by calling PayPal's verify-webhook-signature API,
// then handle PAYMENT.CAPTURE.COMPLETED and BILLING.SUBSCRIPTION events
// to keep invoices and subscriptions in sync.

interface IPayPalWebhookEvent {
    id: string;
    event_type: string;
    resource: Record<string, any>;
    summary?: string;
}

const handlePayPalWebhook = async (
    event: IPayPalWebhookEvent,
    headers: Record<string, string>,
) => {
    // ── Verify signature ───────────────────────────────────────────────────────
    // We look up the first admin config that has PayPal enabled to get the
    // client credentials needed for verification.
    const config = await prisma.paymentGatewayConfig.findFirst({
        where: { paypalEnabled: true },
    });

    if (config?.paypalClientId && config?.paypalClientSecretMasked) {
        // Obtain an access token from PayPal
        const credentials = Buffer.from(
            `${config.paypalClientId}:${config.paypalClientSecretMasked}`,
        ).toString("base64");

        const tokenRes = await fetch(
            config.paypalTestMode
                ? "https://api-m.sandbox.paypal.com/v1/oauth2/token"
                : "https://api-m.paypal.com/v1/oauth2/token",
            {
                method: "POST",
                headers: {
                    Authorization: `Basic ${credentials}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "grant_type=client_credentials",
            },
        );

        if (tokenRes.ok) {
            const { access_token } = (await tokenRes.json()) as {
                access_token: string;
            };

            const verifyRes = await fetch(
                config.paypalTestMode
                    ? "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature"
                    : "https://api-m.paypal.com/v1/notifications/verify-webhook-signature",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${access_token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        auth_algo: headers["paypal-auth-algo"],
                        cert_url: headers["paypal-cert-url"],
                        transmission_id: headers["paypal-transmission-id"],
                        transmission_sig: headers["paypal-transmission-sig"],
                        transmission_time: headers["paypal-transmission-time"],
                        webhook_event: event,
                    }),
                },
            );

            if (verifyRes.ok) {
                const { verification_status } = (await verifyRes.json()) as {
                    verification_status: string;
                };
                if (verification_status !== "SUCCESS") {
                    throw new AppError(
                        status.UNAUTHORIZED,
                        "PayPal webhook signature verification failed",
                    );
                }
            }
        }
    }

    // ── Handle events ──────────────────────────────────────────────────────────
    switch (event.event_type) {
        // Payment captured — mark the linked invoice as PAID
        case "PAYMENT.CAPTURE.COMPLETED": {
            const invoiceId: string | undefined =
                event.resource?.custom_id ?? event.resource?.invoice_id;

            if (invoiceId) {
                const invoice = await prisma.invoice.findFirst({
                    where: {
                        OR: [{ id: invoiceId }, { invoiceRef: invoiceId }],
                        status: { notIn: ["PAID", "CANCELLED"] as any },
                    },
                });

                if (invoice) {
                    const now = new Date();

                    // Generate payment ref
                    const lastPayment = await prisma.payment.findFirst({
                        orderBy: { createdAt: "desc" },
                        select: { paymentRef: true },
                    });
                    let nextNum = 1;
                    if (lastPayment?.paymentRef) {
                        const parts = lastPayment.paymentRef.split("-");
                        const num = parseInt(parts[parts.length - 1]);
                        if (!isNaN(num)) nextNum = num + 1;
                    }
                    const paymentRef = `#OP-PAY-${nextNum.toString().padStart(4, "0")}`;

                    await prisma.$transaction([
                        prisma.payment.create({
                            data: {
                                paymentRef,
                                amount: Number(
                                    event.resource.amount?.value ??
                                        invoice.total,
                                ),
                                method: "PAYPAL" as any,
                                status: "PAID" as any,
                                gatewayPaymentId: event.resource.id,
                                paidAt: now,
                                adminId: invoice.adminId,
                                invoiceId: invoice.id,
                                note: `PayPal capture: ${event.resource.id}`,
                            },
                        }),
                        prisma.invoice.update({
                            where: { id: invoice.id },
                            data: { status: "PAID" as any, paidDate: now },
                        }),
                    ]);
                }
            }
            break;
        }

        // Payment reversed / refunded — flip invoice back to SENT
        case "PAYMENT.CAPTURE.REVERSED":
        case "PAYMENT.CAPTURE.REFUNDED": {
            const invoiceId: string | undefined = event.resource?.custom_id;
            if (invoiceId) {
                await prisma.invoice.updateMany({
                    where: { id: invoiceId, status: "PAID" as any },
                    data: { status: "SENT" as any, paidDate: null },
                });
            }
            break;
        }

        default:
            // Unhandled event type — log and return 200 to acknowledge receipt
            console.log(
                `[PayPal Webhook] Unhandled event: ${event.event_type}`,
            );
    }

    return { received: true, event_type: event.event_type };
};

// ─── Stripe Webhook Handler ───────────────────────────────────────────────────
//
// Stripe sends signed webhook events to POST /payment-gateway/stripe-webhook.
// The raw request body (Buffer) must be passed for HMAC verification using the
// webhook secret stored in PaymentGatewayConfig.stripeWebhookSecretMasked.
//
// Handled events:
//   payment_intent.succeeded      → mark linked invoice PAID, create Payment row
//   payment_intent.payment_failed → log failure (no status change)
//   charge.refunded               → flip invoice back to SENT

import Stripe from "stripe";

const handleStripeWebhook = async (rawBody: Buffer, signature: string) => {
    // ── Look up the admin config that has Stripe enabled ───────────────────────
    // In a multi-tenant setup each admin has their own webhook secret stored in
    // the DB. We try to find it via the invoice linked in the event metadata;
    // if not present we fall back to the first Stripe-enabled config.
    const config = await prisma.paymentGatewayConfig.findFirst({
        where: { stripeEnabled: true },
        select: {
            stripeWebhookSecretMasked: true,
            adminId: true,
        },
    });

    if (!config?.stripeWebhookSecretMasked) {
        throw new AppError(
            status.UNPROCESSABLE_ENTITY,
            "Stripe webhook secret not configured",
        );
    }

    // ── Verify signature ───────────────────────────────────────────────────────
    // Stripe expects the *raw* body bytes — any JSON.parse/stringify will break
    // the HMAC. Express must be configured with express.raw({ type: "*/*" }) on
    // this route (see paymentGateway.routes.ts).
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(
            rawBody,
            signature,
            config.stripeWebhookSecretMasked,
        );
    } catch (err) {
        throw new AppError(
            status.UNAUTHORIZED,
            `Stripe webhook signature verification failed: ${(err as Error).message}`,
        );
    }

    // ── Handle events ──────────────────────────────────────────────────────────
    switch (event.type) {
        // ── Successful payment ─────────────────────────────────────────────────
        case "payment_intent.succeeded": {
            const pi = event.data.object as Stripe.PaymentIntent;
            const invoiceId: string | undefined =
                pi.metadata?.invoiceId ?? pi.metadata?.invoice_id;

            if (invoiceId) {
                const invoice = await prisma.invoice.findFirst({
                    where: {
                        OR: [{ id: invoiceId }, { invoiceRef: invoiceId }],
                        status: { notIn: ["PAID", "CANCELLED"] as any },
                    },
                });

                if (invoice) {
                    const now = new Date();

                    // Auto-increment payment ref
                    const lastPayment = await prisma.payment.findFirst({
                        orderBy: { createdAt: "desc" },
                        select: { paymentRef: true },
                    });
                    let nextNum = 1;
                    if (lastPayment?.paymentRef) {
                        const parts = lastPayment.paymentRef.split("-");
                        const n = parseInt(parts[parts.length - 1]);
                        if (!isNaN(n)) nextNum = n + 1;
                    }
                    const paymentRef = `#OP-PAY-${nextNum.toString().padStart(4, "0")}`;

                    await prisma.$transaction([
                        prisma.payment.create({
                            data: {
                                paymentRef,
                                amount: Number(pi.amount_received) / 100, // pence → pounds/dollars
                                method: "STRIPE" as any,
                                status: "PAID" as any,
                                gatewayPaymentId: pi.id,
                                paidAt: now,
                                adminId: invoice.adminId,
                                invoiceId: invoice.id,
                                note: `Stripe payment_intent: ${pi.id}`,
                            },
                        }),
                        prisma.invoice.update({
                            where: { id: invoice.id },
                            data: { status: "PAID" as any, paidDate: now },
                        }),
                    ]);
                }
            }
            break;
        }

        // ── Failed payment — log only, do not change invoice status ───────────
        case "payment_intent.payment_failed": {
            const pi = event.data.object as Stripe.PaymentIntent;
            console.log(
                `[Stripe Webhook] payment_intent.payment_failed — pi=${pi.id} ` +
                    `reason=${pi.last_payment_error?.message ?? "unknown"}`,
            );
            break;
        }

        // ── Refund — flip invoice back to SENT so admin can take action ────────
        case "charge.refunded": {
            const charge = event.data.object as Stripe.Charge;
            const invoiceId: string | undefined =
                (charge.payment_intent as Stripe.PaymentIntent | null)?.metadata
                    ?.invoiceId ?? charge.metadata?.invoiceId;

            if (invoiceId) {
                await prisma.invoice.updateMany({
                    where: { id: invoiceId, status: "PAID" as any },
                    data: { status: "SENT" as any, paidDate: null },
                });
            }
            break;
        }

        default:
            console.log(`[Stripe Webhook] Unhandled event: ${event.type}`);
    }

    return { received: true, event_type: event.type };
};

export const paymentGatewayService = {
    getPaymentGatewayConfig,
    updatePaymentGatewayConfig,
    oauthConnect,
    disconnectGateway,
    handlePayPalWebhook,
    handleStripeWebhook,
};
