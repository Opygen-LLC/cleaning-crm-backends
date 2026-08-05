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


