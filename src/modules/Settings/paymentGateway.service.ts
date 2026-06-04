import { prisma } from "../../lib/prisma/prisma";
import { PaymentGateway } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

/** Show only last 4 chars — matches the *Masked column convention in the schema */
const mask = (key?: string | null): string | null =>
    key ? `••••••••${key.slice(-4)}` : null;

const getPaymentGatewayConfig = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true, paymentGateway: true },
    });

    if (!admin) throw new Error("Admin profile not found");

    if (!admin.paymentGateway) {
        return prisma.paymentGatewayConfig.create({
            data: { adminId: admin.id },
        });
    }

    return admin.paymentGateway;
};

const updatePaymentGatewayConfig = async (
    userId: string,
    payload: Record<string, unknown>,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new Error("Admin profile not found");

    const {
        stripeSecretKey,
        stripeWebhookSecret,
        paypalClientSecret,
        ...rest
    } = payload as {
        stripeSecretKey?: string;
        stripeWebhookSecret?: string;
        paypalClientSecret?: string;
        [key: string]: unknown;
    };

    const data: Record<string, unknown> = { ...rest };
    if (stripeSecretKey) data.stripeSecretKeyMasked = mask(stripeSecretKey);
    if (stripeWebhookSecret)
        data.stripeWebhookSecretMasked = mask(stripeWebhookSecret);
    if (paypalClientSecret)
        data.paypalClientSecretMasked = mask(paypalClientSecret);

    // FIX: Use explicit "in" checks instead of nullish coalescing so that
    // setting stripeEnabled: false correctly results in PAYPAL or NONE,
    // rather than staying STRIPE because `false ?? current.stripeEnabled`
    // falls through to the still-true DB value.
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

    return prisma.paymentGatewayConfig.upsert({
        where: { adminId: admin.id },
        update: data,
        create: { adminId: admin.id, ...data },
    });
};

// FIX: Added oauthConnect — stores the connectedAccountId/merchantId returned
// after a backend server-to-server OAuth code exchange with Stripe/PayPal.
// The actual token exchange with the provider's API should happen here using
// your Stripe SDK or PayPal SDK. The stub below stores the connection ID.
const oauthConnect = async (
    userId: string,
    gateway: "stripe" | "paypal",
    code: string,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new Error("Admin profile not found");

    // TODO: exchange `code` with Stripe/PayPal using their SDK:
    //   Stripe:  const response = await stripe.oauth.token({ grant_type: "authorization_code", code });
    //   PayPal:  POST https://api.paypal.com/v1/identity/openidconnect/tokenservice
    // For now, store the code as the connected account ID (replace with real exchange).
    const connectedAccountId = `connected_${gateway}_${code.slice(0, 8)}`;

    if (gateway === "stripe") {
        await prisma.paymentGatewayConfig.upsert({
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
        await prisma.paymentGatewayConfig.upsert({
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

    return { success: true, connectedAccountId };
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

    if (gateway === "stripe") {
        if (newActiveGateway === PaymentGateway.STRIPE)
            newActiveGateway = current?.paypalEnabled
                ? PaymentGateway.PAYPAL
                : PaymentGateway.NONE;

        await prisma.paymentGatewayConfig.upsert({
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

        await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                paypalEnabled: false,
                paypalConnectedMerchantId: null,
                activeGateway: newActiveGateway,
            },
            create: { adminId: admin.id },
        });
    }

    return { success: true };
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
