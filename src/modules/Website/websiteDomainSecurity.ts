import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisRateLimitStore } from "../../lib/rateLimit/redisRateLimitStore";

const WINDOW_MS = 15 * 60 * 1000;
const tenantKey = (req: Request) => `tenant:${req.user.adminId ?? req.user.id}`;

/**
 * Domain mutations may call the hosting-provider API and change externally
 * visible routing. Keep the budget low and tenant-scoped across API replicas.
 */
export const websiteDomainMutationRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-domain-mutation",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: tenantKey,
  message: {
    success: false,
    message: "Too many custom-domain changes. Please wait a few minutes and try again.",
    error: { code: "WEBSITE_DOMAIN_MUTATION_RATE_LIMITED", retryable: true },
  },
});

/**
 * Verification is allowed more frequently than add/remove because DNS
 * propagation naturally causes retries, but it still performs DNS lookups,
 * provider API calls and potentially an HTTPS probe.
 */
export const websiteDomainVerificationRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-domain-verification",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: tenantKey,
  message: {
    success: false,
    message: "Too many domain verification checks. Wait for DNS propagation and try again shortly.",
    error: { code: "WEBSITE_DOMAIN_VERIFY_RATE_LIMITED", retryable: true },
  },
});
