import { prisma } from "../../lib/prisma/prisma";
import { PaymentGateway } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import Stripe from "stripe";
import crypto from "crypto";
import { createPayPalReferralUrl } from "../../lib/Payments/paypal.helper";

// ─── AES-256-GCM helpers ──────────────────────────────────────────────────────
// ENCRYPTION_KEY must be a 64-char hex string (32 bytes) in .env
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex");

const encrypt = (plaintext: string): string => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Format: iv(24):tag(32):ciphertext
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
};

const decrypt = (ciphertext: string): string => {
    const [ivHex, tagHex, dataHex] = ciphertext.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final("utf8");
};

// ─── Stripe client factory ────────────────────────────────────────────────────
const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY!);

// ─── Display mask ─────────────────────────────────────────────────────────────
/** Show only last 4 chars — matches the *Masked column convention in the schema */
const mask = (key?: string | null): string | null =>
    key ? `••••••••${key.slice(-4)}` : null;

/**
 * Transforms the flat DB PaymentGatewayConfig row into the nested shape
 * the frontend expects.
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
        connectedAt: cfg.connectedAt ?? null,
        scope: cfg.stripeScope ?? null,
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

// ─── getPaymentGatewayConfig ──────────────────────────────────────────────────
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

// ─── updatePaymentGatewayConfig ───────────────────────────────────────────────
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

// ─── getStripeConnectUrl ──────────────────────────────────────────────────────
// GET /payment-gateway/stripe/connect-url
// Generates a Stripe OAuth URL and stores a CSRF state nonce in the DB.
const getStripeConnectUrl = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    // Cryptographically-random 32-byte nonce for CSRF protection
    const state = crypto.randomBytes(32).toString("hex");

    await prisma.paymentGatewayConfig.upsert({
        where: { adminId: admin.id },
        update: { oauthState: state },
        create: { adminId: admin.id, oauthState: state },
    });

    const params = new URLSearchParams({
        response_type: "code",
        client_id: process.env.STRIPE_CLIENT_ID!,
        scope: "read_write",
        redirect_uri: `${process.env.FRONTEND_URL}/oauth/callback/stripe`,
        state,
    });

    return { url: `https://connect.stripe.com/oauth/authorize?${params}` };
};

// ─── oauthConnect ─────────────────────────────────────────────────────────────
// POST /payment-gateway/oauth
// Exchanges the Stripe/PayPal authorization code for tokens, verifies the
// state nonce, encrypts the access token, and persists everything to the DB.
const oauthConnect = async (
    userId: string,
    gateway: "stripe" | "paypal",
    code: string,
    stateParam?: string,
    ip?: string,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const cfg = await prisma.paymentGatewayConfig.findUnique({
        where: { adminId: admin.id },
    });

    // ── Verify CSRF state nonce ───────────────────────────────────────────────
    if (stateParam) {
        if (!cfg?.oauthState || cfg.oauthState !== stateParam) {
            throw new AppError(
                status.BAD_REQUEST,
                "Invalid OAuth state — possible CSRF",
            );
        }
    }

    let updatedCfg;

    if (gateway === "stripe") {
        // ── Exchange code for Stripe tokens ───────────────────────────────────
        const stripe = getStripe();
        const response = await stripe.oauth.token({
            grant_type: "authorization_code",
            code,
        });

        const connectedAccountId = response.stripe_user_id!;
        const accessToken = response.access_token!;
        const refreshToken = response.refresh_token ?? null;
        const scope = response.scope ?? null;

        // Encrypt access token before storage
        const encryptedAccessToken = encrypt(accessToken);
        const encryptedRefreshToken = refreshToken
            ? encrypt(refreshToken)
            : null;

        updatedCfg = await prisma.paymentGatewayConfig.update({
            where: { adminId: admin.id },
            data: {
                stripeConnectedAccountId: connectedAccountId,
                stripeAccessToken: encryptedAccessToken,
                stripeRefreshToken: encryptedRefreshToken,
                stripeScope: scope,
                stripeEnabled: true,
                activeGateway: PaymentGateway.STRIPE,
                oauthState: null, // clear nonce
                connectedAt: new Date(),
            },
        });

        // Audit log
        await prisma.oAuthConnectLog.create({
            data: {
                adminId: admin.id,
                gateway: PaymentGateway.STRIPE,
                event: "connected",
                ip: ip ?? null,
            },
        });
    } else {
        // ── PayPal PPCP callback — merchantId capture ─────────────────────────
        // PayPal's partner-referral flow does NOT return an auth code.
        // Instead the callback URL carries ?merchantId=xxx&merchantIdInPayPal=yyy
        // The frontend passes merchantId as the `code` param.
        // No token exchange is needed at this point; permissions are granted
        // implicitly via the partner-referral agreement.
        const merchantId = code; // `code` field reused — carries merchantId from frontend

        if (!merchantId) {
            throw new AppError(
                status.BAD_REQUEST,
                "PayPal merchantId is required",
            );
        }

        updatedCfg = await prisma.paymentGatewayConfig.upsert({
            where: { adminId: admin.id },
            update: {
                paypalConnectedMerchantId: merchantId,
                paypalEnabled: true,
                activeGateway: PaymentGateway.PAYPAL,
                oauthState: null,
                connectedAt: new Date(),
            },
            create: {
                adminId: admin.id,
                paypalConnectedMerchantId: merchantId,
                paypalEnabled: true,
                activeGateway: PaymentGateway.PAYPAL,
                connectedAt: new Date(),
            },
        });

        await prisma.oAuthConnectLog.create({
            data: {
                adminId: admin.id,
                gateway: PaymentGateway.PAYPAL,
                event: "connected",
                ip: ip ?? null,
            },
        });
    }

    return {
        success: true,
        config: toClientShape(updatedCfg),
    };
};

// ─── disconnectGateway ────────────────────────────────────────────────────────
// POST /payment-gateway/disconnect
// Revokes the OAuth token on the provider's side, then clears the DB.
const disconnectGateway = async (
    userId: string,
    gateway: "stripe" | "paypal",
    ip?: string,
) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const cfg = await prisma.paymentGatewayConfig.findUnique({
        where: { adminId: admin.id },
    });

    let newActiveGateway = cfg?.activeGateway ?? PaymentGateway.NONE;
    let updatedCfg;

    if (gateway === "stripe") {
        // ── Revoke token on Stripe before clearing DB ─────────────────────────
        if (cfg?.stripeConnectedAccountId) {
            try {
                const stripe = getStripe();
                await stripe.oauth.deauthorize({
                    client_id: process.env.STRIPE_CLIENT_ID!,
                    stripe_user_id: cfg.stripeConnectedAccountId,
                });
            } catch (err) {
                // Log but don't block — DB cleanup should still proceed
                console.error("[Stripe disconnect] deauthorize failed:", err);
            }
        }

        if (newActiveGateway === PaymentGateway.STRIPE)
            newActiveGateway = cfg?.paypalEnabled
                ? PaymentGateway.PAYPAL
                : PaymentGateway.NONE;

        updatedCfg = await prisma.paymentGatewayConfig.update({
            where: { adminId: admin.id },
            data: {
                stripeEnabled: false,
                stripeConnectedAccountId: null,
                stripeAccessToken: null,
                stripeRefreshToken: null,
                stripeTokenExpiresAt: null,
                stripeScope: null,
                connectedAt: null,
                activeGateway: newActiveGateway,
            },
        });

        await prisma.oAuthConnectLog.create({
            data: {
                adminId: admin.id,
                gateway: PaymentGateway.STRIPE,
                event: "disconnected",
                ip: ip ?? null,
            },
        });
    } else {
        if (newActiveGateway === PaymentGateway.PAYPAL)
            newActiveGateway = cfg?.stripeEnabled
                ? PaymentGateway.STRIPE
                : PaymentGateway.NONE;

        updatedCfg = await prisma.paymentGatewayConfig.update({
            where: { adminId: admin.id },
            data: {
                paypalEnabled: false,
                paypalConnectedMerchantId: null,
                paypalAccessToken: null,
                paypalRefreshToken: null,
                paypalTokenExpiresAt: null,
                connectedAt: null,
                activeGateway: newActiveGateway,
            },
        });

        await prisma.oAuthConnectLog.create({
            data: {
                adminId: admin.id,
                gateway: PaymentGateway.PAYPAL,
                event: "disconnected",
                ip: ip ?? null,
            },
        });
    }

    return { success: true, config: toClientShape(updatedCfg) };
};

// ─── PayPal Webhook Handler ───────────────────────────────────────────────────
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
    const config = await prisma.paymentGatewayConfig.findFirst({
        where: { paypalEnabled: true },
    });

    if (config?.paypalClientId && config?.paypalClientSecretMasked) {
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

    switch (event.event_type) {
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
            console.log(
                `[PayPal Webhook] Unhandled event: ${event.event_type}`,
            );
    }

    return { received: true, event_type: event.event_type };
};

// ─── Stripe Webhook Handler ───────────────────────────────────────────────────
const handleStripeWebhook = async (rawBody: Buffer, signature: string) => {
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

    const stripe = getStripe();
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

    switch (event.type) {
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
                                amount: Number(pi.amount_received) / 100,
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

        case "payment_intent.payment_failed": {
            const pi = event.data.object as Stripe.PaymentIntent;
            console.log(
                `[Stripe Webhook] payment_intent.payment_failed — pi=${pi.id} ` +
                    `reason=${pi.last_payment_error?.message ?? "unknown"}`,
            );
            break;
        }

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

// ─── getPayPalReferralUrl ─────────────────────────────────────────────────────
// GET /payment-gateway/paypal/connect-url
// Creates a PayPal partner-referral request and returns the action_url the
// business owner must visit to complete PPCP onboarding.
const getPayPalReferralUrl = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const url = await createPayPalReferralUrl(admin.id);
    return { url };
};

// ─── Exports ──────────────────────────────────────────────────────────────────
export { decrypt }; // exported for use in payment execution helpers

export const paymentGatewayService = {
    getPaymentGatewayConfig,
    updatePaymentGatewayConfig,
    getStripeConnectUrl,
    getPayPalReferralUrl,
    oauthConnect,
    disconnectGateway,
    handlePayPalWebhook,
    handleStripeWebhook,
};
