import { z } from "zod";
import { NODE_ENV, PROCESS_ROLE } from "./ENV";

const nonEmpty = z.string().trim().min(1);
const secret = z.string().trim().min(32);
const absoluteUrl = z.string().trim().url();
const port = z.coerce.number().int().min(1).max(65535);

const productionEnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  DIRECT_URL: nonEmpty,
  REDIS_HOST: nonEmpty,
  REDIS_PORT: port,
  ACCESS_TOKEN_SECRET: secret,
  REFRESH_TOKEN_SECRET: secret,
  BETTER_AUTH_SECRET: secret,
  ACCESS_TOKEN_EXPIRES_IN: nonEmpty,
  REFRESH_TOKEN_EXPIRES_IN: nonEmpty,
  BETTER_AUTH_URL: absoluteUrl,
  APP_URL: absoluteUrl,
  FRONTEND_URL: absoluteUrl,
  AUTH_ALLOWED_ORIGINS: nonEmpty,
  WEBSITE_BASE_DOMAIN: nonEmpty,
  NEXT_REVALIDATE_SECRET: secret,
  NEXT_REVALIDATE_URL: absoluteUrl,
  SMTP_EMAIL: z.string().trim().email(),
  SMTP_PASSWORD: nonEmpty,
  SMTP_HOST: nonEmpty,
  SMTP_PORT: port,
  SMTP_SECURE: z.enum(["true", "false"]).optional(),
  SMTP_FROM: z.string().trim().email().optional(),
  SMTP_VERIFY_ON_STARTUP: z.enum(["true", "false"]).optional(),
  SMTP_HEALTHCHECK_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).optional(),
  OUTBOX_WORKER_ENABLED: z.enum(["true", "false"]).optional(),
  OUTBOX_WORKER_REQUIRED: z.enum(["true", "false"]).optional(),
  OUTBOX_WORKER_POLL_MS: z.coerce.number().int().min(500).max(60_000).optional(),
  OUTBOX_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).optional(),
  OUTBOX_LOCK_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(15 * 60_000).optional(),
  // Cloudflare R2 is the only supported media provider in production.
  STORAGE_PROVIDER: z.literal("r2"),
  R2_ACCOUNT_ID: nonEmpty,
  R2_ACCESS_KEY_ID: nonEmpty,
  R2_SECRET_ACCESS_KEY: nonEmpty,
  R2_PUBLIC_BUCKET: nonEmpty,
  R2_PRIVATE_BUCKET: nonEmpty,
  R2_ENDPOINT: absoluteUrl,
  R2_REGION: z.literal("auto").default("auto"),
  R2_PUBLIC_BASE_URL: absoluteUrl,
  R2_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).optional(),
  R2_PRIVATE_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).optional(),
  R2_MAX_IMAGE_SIZE_MB: z.coerce.number().positive().max(25).optional(),
  R2_MAX_DOCUMENT_SIZE_MB: z.coerce.number().positive().max(100).optional(),
  R2_IMAGE_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(8).optional(),
  ALLOW_R2_DEV_DOMAIN: z.enum(["true", "false"]).optional(),
  APP_VERSION: nonEmpty.default("1.0.0"),
  GIT_SHA: nonEmpty.default("production"),
  BUILD_DATE: nonEmpty.default(new Date().toISOString()),
  WEBSITE_CUSTOM_DOMAINS_ENABLED: z.enum(["true", "false"]).default("false"),
  WEBSITE_DOMAIN_PROVIDER: z.enum(["vercel", "manual"]).default("manual"),
  VERCEL_ACCESS_TOKEN: z.string().trim().optional(),
  VERCEL_PROJECT_ID: z.string().trim().optional(),
  WEBSITE_CNAME_TARGET: z.string().trim().optional(),
}).superRefine((env, ctx) => {
  const parseDbUrl = (value: string) => {
    try { return new URL(value); } catch { return null; }
  };
  const runtimeDb = parseDbUrl(env.DATABASE_URL);
  const directDb = parseDbUrl(env.DIRECT_URL);
  const isNeon = (url: URL | null) => Boolean(url && /(?:^|\.)neon\.tech$/i.test(url.hostname));

  if (isNeon(runtimeDb) && !runtimeDb!.hostname.includes("-pooler.")) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "must use the Neon pooled (-pooler) endpoint for runtime traffic",
    });
  }
  if (isNeon(directDb) && directDb!.hostname.includes("-pooler.")) {
    ctx.addIssue({
      code: "custom",
      path: ["DIRECT_URL"],
      message: "must use the direct non-pooler Neon endpoint for Prisma migrations",
    });
  }

  for (const key of ["BETTER_AUTH_URL", "APP_URL", "FRONTEND_URL", "NEXT_REVALIDATE_URL"] as const) {
    const val = env[key];
    const isIpHost = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/i.test(val) || /^https?:\/\/localhost(:\d+)?/i.test(val);
    if (!val.startsWith("https://") && !isIpHost && process.env.ALLOW_HTTP_API_PROXY !== "true") {
      ctx.addIssue({ code: "custom", path: [key], message: "must use https:// in production" });
    }
  }

  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) {
    ctx.addIssue({ code: "custom", path: ["R2_ACCOUNT_ID"], message: "must be the 32-character Cloudflare account ID" });
  }
  try {
    const endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
      ctx.addIssue({ code: "custom", path: ["R2_ENDPOINT"], message: "must be the account-scoped Cloudflare R2 S3 endpoint" });
    }
  } catch {
    ctx.addIssue({ code: "custom", path: ["R2_ENDPOINT"], message: "must be the account-scoped Cloudflare R2 S3 endpoint" });
  }
  try {
    const publicBase = new URL(env.R2_PUBLIC_BASE_URL);
    const allowR2Dev = process.env.ALLOW_R2_DEV_DOMAIN === "true";
    if (publicBase.protocol !== "https:" || (!allowR2Dev && /(?:\.r2\.dev|\.r2\.cloudflarestorage\.com)$/i.test(publicBase.hostname)) || (allowR2Dev && /\.r2\.cloudflarestorage\.com$/i.test(publicBase.hostname))) {
      ctx.addIssue({ code: "custom", path: ["R2_PUBLIC_BASE_URL"], message: "must use an https production custom media domain, not r2.dev or the S3 API endpoint" });
    }
  } catch {
    ctx.addIssue({ code: "custom", path: ["R2_PUBLIC_BASE_URL"], message: "must use an https production custom media domain" });
  }
  if (env.R2_PUBLIC_BUCKET === env.R2_PRIVATE_BUCKET) {
    ctx.addIssue({ code: "custom", path: ["R2_PRIVATE_BUCKET"], message: "must be different from R2_PUBLIC_BUCKET" });
  }

  const baseDomain = env.WEBSITE_BASE_DOMAIN.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!baseDomain.includes(".") || baseDomain.includes("/") || baseDomain.includes(":")) {
    ctx.addIssue({ code: "custom", path: ["WEBSITE_BASE_DOMAIN"], message: "must be a hostname, not a URL" });
  }

  if (!/^\d+(?:ms|s|m|h|d)$/i.test(env.ACCESS_TOKEN_EXPIRES_IN)) {
    ctx.addIssue({ code: "custom", path: ["ACCESS_TOKEN_EXPIRES_IN"], message: "must be a valid duration such as 15m or 1d" });
  }

  if (!/^\d+(?:ms|s|m|h|d)$/i.test(env.REFRESH_TOKEN_EXPIRES_IN)) {
    ctx.addIssue({ code: "custom", path: ["REFRESH_TOKEN_EXPIRES_IN"], message: "must be a duration such as 30d" });
  }

  for (const key of ["APP_VERSION", "GIT_SHA", "BUILD_DATE"] as const) {
    if (["unknown", "local", "dev", "development"].includes(env[key].toLowerCase())) {
      ctx.addIssue({ code: "custom", path: [key], message: "must identify the immutable production release" });
    }
  }

  const authSecrets = [env.ACCESS_TOKEN_SECRET, env.REFRESH_TOKEN_SECRET, env.BETTER_AUTH_SECRET];
  if (new Set(authSecrets).size !== authSecrets.length) {
    ctx.addIssue({ code: "custom", path: ["ACCESS_TOKEN_SECRET"], message: "access, refresh and Better Auth secrets must be distinct" });
  }

  if (env.WEBSITE_CUSTOM_DOMAINS_ENABLED === "true" && env.WEBSITE_DOMAIN_PROVIDER === "vercel") {
    if (!env.VERCEL_ACCESS_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["VERCEL_ACCESS_TOKEN"], message: "is required when Vercel custom domains are enabled" });
    }
    if (!env.VERCEL_PROJECT_ID) {
      ctx.addIssue({ code: "custom", path: ["VERCEL_PROJECT_ID"], message: "is required when Vercel custom domains are enabled" });
    }
  }
  if (env.WEBSITE_CUSTOM_DOMAINS_ENABLED === "true" && env.WEBSITE_DOMAIN_PROVIDER === "manual" && !env.WEBSITE_CNAME_TARGET) {
    ctx.addIssue({ code: "custom", path: ["WEBSITE_CNAME_TARGET"], message: "is required when manual custom domains are enabled" });
  }
});


const forbiddenProductionKeys = [
  "E2E_FRONTEND_URL",
  "E2E_API_URL",
  "E2E_TEST_EMAIL_DOMAIN",
  "E2E_TEST_PASSWORD",
  "E2E_ACCESS_TOKEN_TTL_SECONDS",
  "E2E_TEST_TOKEN",
] as const;

let validated = false;

/**
 * Fail-fast production configuration validation shared by every process role.
 * This deliberately validates only presence/shape; provider connectivity is
 * checked by the existing readiness/worker probes after startup.
 */
export const assertRuntimeEnvironment = (): void => {
  if (validated || NODE_ENV !== "production") return;

  const configuredTestKeys = forbiddenProductionKeys.filter((key) => Boolean(process.env[key]?.trim()));
  if (process.env.E2E_TEST_HOOKS_ENABLED === "true" || configuredTestKeys.length > 0) {
    throw new Error(`E2E test hooks/credentials are forbidden in production: ${[
      ...(process.env.E2E_TEST_HOOKS_ENABLED === "true" ? ["E2E_TEST_HOOKS_ENABLED"] : []),
      ...configuredTestKeys,
    ].join(", ")}`);
  }

  const parsed = productionEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid production environment for ${PROCESS_ROLE}: ${details}`);
  }

  // Production must have one unambiguous durable-outbox owner. API processes
  // enqueue only; the dedicated worker consumes. This fails fast if a shared
  // env file accidentally turns queue polling back on in the web process.
  if (PROCESS_ROLE === "api" && process.env.OUTBOX_WORKER_ENABLED !== "false") {
    throw new Error("Invalid production environment for api: OUTBOX_WORKER_ENABLED must be false; run the dedicated worker process instead.");
  }
  if (PROCESS_ROLE === "api" && process.env.OUTBOX_WORKER_REQUIRED === "false") {
    throw new Error("Invalid production environment for api: OUTBOX_WORKER_REQUIRED cannot be false because registration verification depends on the dedicated worker.");
  }
  if (PROCESS_ROLE === "worker" && process.env.OUTBOX_WORKER_ENABLED === "false") {
    throw new Error("Invalid production environment for worker: OUTBOX_WORKER_ENABLED must not be false.");
  }

  validated = true;
};
