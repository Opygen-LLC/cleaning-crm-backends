import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisRateLimitStore } from "../../lib/rateLimit/redisRateLimitStore";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Signed branding uploads are authenticated, but they still consume provider
 * storage/transformation capacity. Keep the allowance tenant-scoped and
 * distributed across API replicas so a compromised browser session cannot
 * generate an unbounded number of provider uploads.
 */
export const websiteBrandUploadRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 80,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-brand-upload",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: (req: Request) => `tenant:${req.user.adminId ?? req.user.id}`,
  message: {
    success: false,
    message: "Too many branding upload requests. Please wait a few minutes and try again.",
    error: { code: "WEBSITE_BRAND_UPLOAD_RATE_LIMITED", retryable: true },
  },
});


export const websiteContentUploadRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "website-content-upload",
    windowMs: WINDOW_MS,
    maxFallbackEntries: 5_000,
  }),
  keyGenerator: (req: Request) => `tenant:${req.user.adminId ?? req.user.id}`,
  message: {
    success: false,
    message: "Too many website image uploads. Please wait a few minutes and try again.",
    error: { code: "WEBSITE_CONTENT_UPLOAD_RATE_LIMITED", retryable: true },
  },
});
