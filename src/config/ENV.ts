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
export const DB_POOL_MAX: number = Math.min(100, Math.max(1, Number(process.env.DB_POOL_MAX) || 10));
export const DB_POOL_MIN: number = Math.min(
    DB_POOL_MAX,
    Math.max(0, Number(process.env.DB_POOL_MIN) || Math.min(2, DB_POOL_MAX)),
);
export const DB_POOL_IDLE_TIMEOUT_MS: number = Math.max(30_000, Number(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 600_000);
export const DB_POOL_CONNECTION_TIMEOUT_MS: number = Math.max(5_000, Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS) || 15_000);

// Logs any query slower than this many ms via the Phase 1.3 slow-query
// logger in src/lib/prisma/prisma.ts. Defaults to 300ms.
export const SLOW_QUERY_THRESHOLD_MS: number =
    Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 300;

export const API_RESPONSE_CACHE_TTL_SECONDS: number = Math.max(
    5,
    Number(process.env.API_RESPONSE_CACHE_TTL_SECONDS) || 300,
);
export const WEBSITE_STUDIO_CACHE_TTL_SECONDS: number = Math.min(300, Math.max(15,
    Number(process.env.WEBSITE_STUDIO_CACHE_TTL_SECONDS) || 60,
));
export const REQUEST_LOG_SAMPLE_RATE: number = Math.min(
    1,
    Math.max(0, Number(process.env.REQUEST_LOG_SAMPLE_RATE ?? 0.01)),
);
export const SLOW_REQUEST_THRESHOLD_MS: number = Math.max(
    50,
    Number(process.env.SLOW_REQUEST_THRESHOLD_MS) || 250,
);
export const TRUST_PROXY_HOPS: number = Math.min(5, Math.max(0, Math.trunc(Number(process.env.TRUST_PROXY_HOPS) || 0)));

export const PERFORMANCE_METRICS_TOKEN: string | undefined = process.env.PERFORMANCE_METRICS_TOKEN?.trim() || undefined;

// Infrastructure placement guard. In production set all three region labels
// and keep REQUIRE_COLOCATED_INFRA enabled after moving API/Postgres/Redis together.
// REDIS_REGION=local means Redis runs beside the API (e.g. Docker Compose).
export const APP_REGION: string | undefined = process.env.APP_REGION?.trim() || undefined;
export const DATABASE_REGION: string | undefined = process.env.DATABASE_REGION?.trim() || undefined;
export const REDIS_REGION: string | undefined = process.env.REDIS_REGION?.trim() || undefined;
export const REQUIRE_COLOCATED_INFRA: boolean = process.env.REQUIRE_COLOCATED_INFRA === "true" || (NODE_ENV === "production" && process.env.REQUIRE_COLOCATED_INFRA !== "false");

export const REDIS_CONNECT_TIMEOUT_MS: number = Math.min(10_000, Math.max(250, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 1_500));
export const REDIS_COMMAND_TIMEOUT_MS: number = Math.min(2_000, Math.max(25, Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 150));
export const REDIS_KEEPALIVE_MS: number = Math.min(60_000, Math.max(1_000, Number(process.env.REDIS_KEEPALIVE_MS) || 10_000));
const parsedRedisMaxRetries = Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST ?? "1");
export const REDIS_MAX_RETRIES_PER_REQUEST: number = Math.min(
    3,
    Math.max(0, Math.trunc(Number.isFinite(parsedRedisMaxRetries) ? parsedRedisMaxRetries : 1)),
);

export const DB_KEEPALIVE_ENABLED: boolean = process.env.DB_KEEPALIVE_ENABLED !== "false";
export const DB_KEEPALIVE_CRON: string = process.env.DB_KEEPALIVE_CRON?.trim() || "*/2 * * * *";

// Phase 2 durable transactional outbox. The web process may run the worker
// in-process (safe across multiple replicas via FOR UPDATE SKIP LOCKED), or a
// dedicated worker process can enable the same poller independently.
export const OUTBOX_WORKER_ENABLED: boolean = process.env.OUTBOX_WORKER_ENABLED !== "false";
export const OUTBOX_WORKER_POLL_MS: number = Math.min(60_000, Math.max(500, Number(process.env.OUTBOX_WORKER_POLL_MS) || 1_000));
export const OUTBOX_WORKER_BATCH_SIZE: number = Math.min(100, Math.max(1, Math.trunc(Number(process.env.OUTBOX_WORKER_BATCH_SIZE) || 10)));
export const OUTBOX_LOCK_TIMEOUT_MS: number = Math.min(15 * 60_000, Math.max(30_000, Number(process.env.OUTBOX_LOCK_TIMEOUT_MS) || 120_000));

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

// Shared parent domain for ONLY the short-lived access/role cookies used by
// the frontend Next.js proxy (production example: .opygen.com). Refresh and
// Better Auth session cookies remain host-only on the API. Leave unset locally.
export const COOKIE_DOMAIN: string | undefined = process.env.COOKIE_DOMAIN?.trim() || undefined;

export const AUTH_ALLOWED_ORIGINS: string[] = (process.env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export type ProcessRole = "api" | "worker" | "scheduler" | "bootstrap";
export const PROCESS_ROLE: ProcessRole = (() => {
    const value = (process.env.PROCESS_ROLE || "api").trim().toLowerCase();
    if (["api", "worker", "scheduler", "bootstrap"].includes(value)) return value as ProcessRole;
    throw new Error(`Invalid PROCESS_ROLE: ${value}`);
})();

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
// Phase 1 registration always reserves the tenant subdomain label and returns
// it to the client. Set WEBSITE_BASE_DOMAIN to also return a complete publicUrl
// such as https://bio-cleaning.sites.example.com. The label itself remains
// safely provisioned even when wildcard routing is not enabled in local dev.
export const WEBSITE_BASE_DOMAIN: string | undefined = process.env.WEBSITE_BASE_DOMAIN
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
export const WEBSITE_CNAME_TARGET: string | undefined = process.env.WEBSITE_CNAME_TARGET
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");

// Phase 5 production host resolver cache. Positive routes can live for a few minutes;
// unknown hosts are cached only briefly to absorb wildcard-DNS scans without
// delaying legitimate provisioning/renames for long. TTL jitter prevents a
// fleet of host keys from expiring simultaneously.
export const WEBSITE_ROUTE_CACHE_TTL_SECONDS: number = Math.min(3600, Math.max(30,
    Number(process.env.WEBSITE_ROUTE_CACHE_TTL_SECONDS) || 300,
));
export const WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS: number = Math.min(60, Math.max(3,
    Number(process.env.WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS) || 10,
));
export const WEBSITE_ROUTE_CACHE_JITTER_RATIO: number = Math.min(0.4, Math.max(0,
    Number(process.env.WEBSITE_ROUTE_CACHE_JITTER_RATIO) || 0.15,
));
export const WEBSITE_ROUTE_REBUILD_LOCK_SECONDS: number = Math.min(10, Math.max(1,
    Number(process.env.WEBSITE_ROUTE_REBUILD_LOCK_SECONDS) || 3,
));
export const WEBSITE_ROUTE_WAIT_FOR_FILL_MS: number = Math.min(2_000, Math.max(100,
    Number(process.env.WEBSITE_ROUTE_WAIT_FOR_FILL_MS) || 600,
));

// Phase 7 custom-domain provider integration. `vercel` registers the tenant
// hostname on the frontend Vercel project and lets Vercel manage certificates.
// `manual` keeps DNS verification in-app but assumes TLS/routing is managed by
// external infrastructure. Never infer a Vercel project from the runtime.
export const WEBSITE_CUSTOM_DOMAINS_ENABLED: boolean =
    process.env.WEBSITE_CUSTOM_DOMAINS_ENABLED?.trim().toLowerCase() === "true";
export const WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE: number = Math.min(25, Math.max(1,
    Number(process.env.WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE) || 10,
));
export const WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS: number = Math.min(180, Math.max(30,
    Number(process.env.WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS) || 90,
));
export const WEBSITE_TLS_PROBE_TIMEOUT_MS: number = Math.min(10_000, Math.max(1_000,
    Number(process.env.WEBSITE_TLS_PROBE_TIMEOUT_MS) || 4_000,
));
export const WEBSITE_DOMAIN_PROVIDER: "vercel" | "manual" =
    process.env.WEBSITE_DOMAIN_PROVIDER?.trim().toLowerCase() === "vercel"
        ? "vercel"
        : "manual";
export const VERCEL_ACCESS_TOKEN: string | undefined = process.env.VERCEL_ACCESS_TOKEN?.trim();
export const VERCEL_PROJECT_ID: string | undefined = process.env.VERCEL_PROJECT_ID?.trim();
export const VERCEL_TEAM_ID: string | undefined = process.env.VERCEL_TEAM_ID?.trim();

// ─── Phase 9 website reliability / observability ────────────────────────────
export const ANALYTICS_HASH_SECRET: string | undefined = process.env.ANALYTICS_HASH_SECRET?.trim();
export const TURNSTILE_SECRET_KEY: string | undefined = process.env.TURNSTILE_SECRET_KEY?.trim();
export const ERROR_MONITOR_WEBHOOK_URL: string | undefined = process.env.ERROR_MONITOR_WEBHOOK_URL?.trim();
export const ERROR_MONITOR_WEBHOOK_TOKEN: string | undefined = process.env.ERROR_MONITOR_WEBHOOK_TOKEN?.trim();
export const ERROR_MONITOR_SERVICE_NAME: string = process.env.ERROR_MONITOR_SERVICE_NAME?.trim() || "cleaning-crm-api";
export const RELEASE_VERSION: string = process.env.RELEASE_VERSION?.trim() || process.env.GIT_SHA?.trim() || "unknown";
export const WEBSITE_ANALYTICS_RETENTION_DAYS: number = Math.min(730, Math.max(30, Number(process.env.WEBSITE_ANALYTICS_RETENTION_DAYS) || 180));
export const WEBSITE_PROJECTION_CACHE_TTL_SECONDS: number = Math.min(1800, Math.max(30, Number(process.env.WEBSITE_PROJECTION_CACHE_TTL_SECONDS) || 180));
export const WEBSITE_PROJECTION_CACHE_JITTER_RATIO: number = Math.min(0.4, Math.max(0, Number(process.env.WEBSITE_PROJECTION_CACHE_JITTER_RATIO) || 0.15));
export const WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS: number = Math.min(30, Math.max(2, Number(process.env.WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS) || 8));
export const WEBSITE_PROJECTION_STALE_TTL_SECONDS: number = Math.min(7200, Math.max(120, Number(process.env.WEBSITE_PROJECTION_STALE_TTL_SECONDS) || 900));
export const WEBSITE_PROJECTION_WAIT_FOR_FILL_MS: number = Math.min(3_000, Math.max(100, Number(process.env.WEBSITE_PROJECTION_WAIT_FOR_FILL_MS) || 1_200));
export const WEBSITE_ERROR_DEDUPE_TTL_SECONDS: number = Math.min(3600, Math.max(10, Number(process.env.WEBSITE_ERROR_DEDUPE_TTL_SECONDS) || 120));

// Phase 8 — signed Next.js Data Cache invalidation. The URL normally points
// to the frontend Route Handler. Mutations enqueue durable outbox events so
// public projection freshness does not depend on an in-process fire-and-forget.
const normalizedFrontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/+$/, "");
export const NEXT_REVALIDATE_URL: string | undefined = process.env.NEXT_REVALIDATE_URL?.trim()
    || (normalizedFrontendUrl ? `${normalizedFrontendUrl}/api/public-site/revalidate` : undefined);
export const NEXT_REVALIDATE_SECRET: string | undefined = process.env.NEXT_REVALIDATE_SECRET?.trim() || undefined;
export const NEXT_REVALIDATE_TIMEOUT_MS: number = Math.min(10_000, Math.max(500,
    Number(process.env.NEXT_REVALIDATE_TIMEOUT_MS) || 2_500,
));
