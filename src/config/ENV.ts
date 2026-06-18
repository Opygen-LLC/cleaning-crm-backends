import dotenv from "dotenv";
dotenv.config();

export const NODE_ENV: string = process.env.NODE_ENV as string;
export const BACKEND_IP: string = process.env.BACKEND_IP as string;
export const PORT: number = parseInt(process.env.PORT as string, 10);
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

export const CLOUDINARY_CLOUD_NAME: string = process.env
    .CLOUDINARY_CLOUD_NAME as string;
export const CLOUDINARY_API_KEY: string = process.env
    .CLOUDINARY_API_KEY as string;
export const CLOUDINARY_API_SECRET: string = process.env
    .CLOUDINARY_API_SECRET as string;

export const BETTER_AUTH_SECRET: string = process.env
    .BETTER_AUTH_SECRET as string;
export const BETTER_AUTH_URL: string = process.env.BETTER_AUTH_URL as string;
export const APP_URL: string = process.env.APP_URL as string;
export const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

export const ACCESS_TOKEN_SECRET: string = process.env
    .ACCESS_TOKEN_SECRET as string;
export const REFRESH_TOKEN_SECRET: string = process.env
    .REFRESH_TOKEN_SECRET as string;
export const ACCESS_TOKEN_EXPIRES_IN: string = process.env
    .ACCESS_TOKEN_EXPIRES_IN as string;
export const REFRESH_TOKEN_EXPIRES_IN: string = process.env
    .REFRESH_TOKEN_EXPIRES_IN as string;

export const SUPER_ADMIN_EMAIL: string = process.env
    .SUPER_ADMIN_EMAIL as string;
export const SUPER_ADMIN_PASSWORD: string = process.env
    .SUPER_ADMIN_PASSWORD as string;

export const SMTP_EMAIL: string = process.env.SMTP_EMAIL as string;
export const SMTP_PASSWORD: string = process.env.SMTP_PASSWORD as string;
export const SMTP_HOST: string = process.env.SMTP_HOST as string;
export const SMTP_PORT: string = process.env.SMTP_PORT as string;

// ─── Stripe ───────────────────────────────────────────────────────────────────
export const STRIPE_SECRET_KEY: string = process.env
    .STRIPE_SECRET_KEY as string;

/** Stripe Connect platform client ID — from Dashboard → Connect settings */
export const STRIPE_CLIENT_ID: string = process.env.STRIPE_CLIENT_ID as string;

/** Webhook signing secret for verifying Stripe webhook payloads */
export const STRIPE_WEBHOOK_SECRET: string = process.env
    .STRIPE_WEBHOOK_SECRET as string;

// ─── PayPal PPCP ──────────────────────────────────────────────────────────────
/** Platform app client ID (from PayPal Developer Dashboard) */
export const PAYPAL_CLIENT_ID: string = process.env.PAYPAL_CLIENT_ID as string;

/** Platform app secret */
export const PAYPAL_SECRET: string = process.env.PAYPAL_SECRET as string;

/** Your platform's PayPal merchant/partner ID (payer_id) */
export const PAYPAL_PARTNER_ID: string = process.env
    .PAYPAL_PARTNER_ID as string;

/** "true" for sandbox, "false" for production */
export const PAYPAL_SANDBOX: string = process.env.PAYPAL_SANDBOX as string;

/** Optional: URL of your logo shown on the PayPal onboarding page */
export const PAYPAL_PARTNER_LOGO_URL: string | undefined =
    process.env.PAYPAL_PARTNER_LOGO_URL;

// ─── Token encryption ─────────────────────────────────────────────────────────
/**
 * 64-character hex string (32 bytes) used for AES-256-GCM encryption of
 * OAuth access/refresh tokens stored in PaymentGatewayConfig.
 * Generate with: openssl rand -hex 32
 */
export const ENCRYPTION_KEY: string = process.env.ENCRYPTION_KEY as string;
