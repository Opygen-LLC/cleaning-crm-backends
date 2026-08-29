import { z } from "zod";
import { NODE_ENV, PROCESS_ROLE } from "./ENV";

const nonEmpty = z.string().trim().min(1);
const secret = z.string().trim().min(32);
const absoluteUrl = z.string().trim().url();
const port = z.coerce.number().int().min(1).max(65535);

const productionEnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  REDIS_HOST: nonEmpty,
  REDIS_PORT: port,
  ACCESS_TOKEN_SECRET: secret,
  REFRESH_TOKEN_SECRET: secret,
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: absoluteUrl,
  APP_URL: absoluteUrl,
  FRONTEND_URL: absoluteUrl,
  WEBSITE_BASE_DOMAIN: nonEmpty,
  NEXT_REVALIDATE_SECRET: secret,
  NEXT_REVALIDATE_URL: absoluteUrl,
  SMTP_EMAIL: z.string().trim().email(),
  SMTP_PASSWORD: nonEmpty,
  SMTP_HOST: nonEmpty,
  SMTP_PORT: port,
  CLOUDINARY_CLOUD_NAME: nonEmpty,
  CLOUDINARY_API_KEY: nonEmpty,
  CLOUDINARY_API_SECRET: nonEmpty,
  WEBSITE_CUSTOM_DOMAINS_ENABLED: z.enum(["true", "false"]).default("false"),
  WEBSITE_DOMAIN_PROVIDER: z.enum(["vercel", "manual"]).default("manual"),
  VERCEL_ACCESS_TOKEN: z.string().trim().optional(),
  VERCEL_PROJECT_ID: z.string().trim().optional(),
  WEBSITE_CNAME_TARGET: z.string().trim().optional(),
}).superRefine((env, ctx) => {
  for (const key of ["BETTER_AUTH_URL", "APP_URL", "FRONTEND_URL", "NEXT_REVALIDATE_URL"] as const) {
    if (!env[key].startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: [key], message: "must use https:// in production" });
    }
  }

  const baseDomain = env.WEBSITE_BASE_DOMAIN.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!baseDomain.includes(".") || baseDomain.includes("/") || baseDomain.includes(":")) {
    ctx.addIssue({ code: "custom", path: ["WEBSITE_BASE_DOMAIN"], message: "must be a hostname, not a URL" });
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

let validated = false;

/**
 * Fail-fast production configuration validation shared by every process role.
 * This deliberately validates only presence/shape; provider connectivity is
 * checked by the existing readiness/worker probes after startup.
 */
export const assertRuntimeEnvironment = (): void => {
  if (validated || NODE_ENV !== "production") return;

  const parsed = productionEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid production environment for ${PROCESS_ROLE}: ${details}`);
  }
  validated = true;
};
