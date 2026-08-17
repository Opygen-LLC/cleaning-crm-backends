import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisRateLimitStore } from "../../lib/rateLimit/redisRateLimitStore";

const WINDOW_MS = 15 * 60 * 1000;
const tenantKey = (req: Request) => `tenant:${req.user.adminId ?? req.user.id}`;

/**
 * Availability checks are authenticated but may run repeatedly while an owner
 * edits their free website address. Keep them tenant-scoped and distributed so
 * one compromised session cannot turn the reservation tables into a hot read
 * path across API replicas.
 */
export const websiteSubdomainAvailabilityRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-subdomain-availability",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: tenantKey,
  message: {
    success: false,
    message: "Too many website address checks. Please wait a few minutes and try again.",
    error: { code: "WEBSITE_SUBDOMAIN_CHECK_RATE_LIMITED", retryable: true },
  },
});

/**
 * A subdomain rename changes externally visible routing and creates a permanent
 * alias, so keep a deliberately low authenticated mutation budget. Database
 * advisory locks still provide the correctness boundary; this limiter protects
 * operational capacity and accidental rapid rename loops.
 */
export const websiteSubdomainMutationRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-subdomain-mutation",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: tenantKey,
  message: {
    success: false,
    message: "Too many website address changes. Please wait a few minutes and try again.",
    error: { code: "WEBSITE_SUBDOMAIN_CHANGE_RATE_LIMITED", retryable: true },
  },
});
