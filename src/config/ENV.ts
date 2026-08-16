import dotenv from "dotenv";
dotenv.config();

export const NODE_ENV: string = process.env.NODE_ENV as string;
export const BACKEND_IP: string = process.env.BACKEND_IP as string;
export const PORT: number = parseInt(process.env.PORT as string, 10);
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// ─── DB connection pool (Phase 1.2 of the performance audit) ───────────────
// Neon's pooled ("PgBouncer") connection strings comfortably support far
// more than the previous hardcoded max of 10 — check your Neon compute
// size/plan for the actual ceiling and set DB_POOL_MAX accordingly in env.
// Falls back to 10 only if the env var is missing/invalid, matching the
// previous hardcoded behaviour so this is a safe no-op until configured.
export const DB_POOL_MAX: number = Number(process.env.DB_POOL_MAX) || 10;

// Logs any query slower than this many ms via the Phase 1.3 slow-query
// logger in src/lib/prisma/prisma.ts. Defaults to 300ms.
export const SLOW_QUERY_THRESHOLD_MS: number =
    Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 300;

export const API_RESPONSE_CACHE_TTL_SECONDS: number = Math.max(
    5,
    Number(process.env.API_RESPONSE_CACHE_TTL_SECONDS) || 300,
);
export const REQUEST_LOG_SAMPLE_RATE: number = Math.min(
    1,
    Math.max(0, Number(process.env.REQUEST_LOG_SAMPLE_RATE ?? 0.01)),
);
export const SLOW_REQUEST_THRESHOLD_MS: number = Math.max(
    50,
    Number(process.env.SLOW_REQUEST_THRESHOLD_MS) || 250,
);

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

// Cookie domain shared across subdomains (e.g. api.faysaldev.com and
// app.faysaldev.com both need to read the same cookie). Leave unset in
// local dev (localhost) where a domain attribute would break cookies.
export const COOKIE_DOMAIN: string | undefined = process.env.COOKIE_DOMAIN;

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
export const SMTP_SECURE: string | undefined = process.env.SMTP_SECURE;
export const SMTP_FROM: string | undefined = process.env.SMTP_FROM;
export const VAPID_PUBLIC_KEY: string | undefined = process.env.VAPID_PUBLIC_KEY;
export const VAPID_PRIVATE_KEY: string | undefined = process.env.VAPID_PRIVATE_KEY;
export const VAPID_SUBJECT: string = process.env.VAPID_SUBJECT || "mailto:support@opygen.com";

// ─── Geocoding (Phase 2 — location-aware dispatch) ─────────────────────────────
// Provider is chosen explicitly rather than inferred from which key is set,
// so a misconfigured env doesn't silently fall back to the wrong provider.
// Supported values: "google" | "mapbox". Geocoding is skipped (addresses
// simply stay ungeocoded) if this is unset or the matching key is missing —
// see src/lib/utils/geocoding.ts.
export const GEOCODING_PROVIDER: string | undefined =
    process.env.GEOCODING_PROVIDER;
export const GOOGLE_MAPS_API_KEY: string | undefined =
    process.env.GOOGLE_MAPS_API_KEY;
export const MAPBOX_ACCESS_TOKEN: string | undefined =
    process.env.MAPBOX_ACCESS_TOKEN;

// ─── Business websites ──────────────────────────────────────────────────────
// These are optional during Phase 1 because no registration flow provisions a
// website yet. Phase 2/6 deployment should set WEBSITE_BASE_DOMAIN before
// enabling automatic tenant subdomains; Phase 7 uses WEBSITE_CNAME_TARGET for
// custom-domain DNS instructions.
export const WEBSITE_BASE_DOMAIN: string | undefined = process.env.WEBSITE_BASE_DOMAIN
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
export const WEBSITE_CNAME_TARGET: string | undefined = process.env.WEBSITE_CNAME_TARGET
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
