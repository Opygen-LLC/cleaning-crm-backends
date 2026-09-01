import type { Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import { RedisRateLimitStore } from "../lib/rateLimit/redisRateLimitStore";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const FIFTEEN_MINUTES = 15 * MINUTE;

type PrivateLimitClass = "private-read" | "private-write" | "report-export";

interface LimitPolicy {
  limit: number;
  windowMs: number;
  store: RedisRateLimitStore;
  ipStore: RedisRateLimitStore;
  ipMultiplier: number;
}

const makePolicy = (
  name: PrivateLimitClass,
  limit: number,
  windowMs: number,
  ipMultiplier = 4,
): LimitPolicy => ({
  limit,
  windowMs,
  store: new RedisRateLimitStore({ prefix: name, windowMs }),
  ipStore: new RedisRateLimitStore({ prefix: `${name}:ip`, windowMs }),
  ipMultiplier,
});

/**
 * Authenticated dashboard traffic is intentionally given generous ceilings.
 * These limits protect expensive endpoints from runaway polling/automation
 * without turning ordinary navigation, RTK revalidation, or multi-tab use into
 * 429s. Redis keeps the allowance consistent across API replicas; the shared
 * store's bounded local fallback keeps protection active during Redis outages.
 */
const POLICIES: Record<PrivateLimitClass, LimitPolicy> = {
  "private-read": makePolicy("private-read", 600, MINUTE, 5),
  "private-write": makePolicy("private-write", 180, MINUTE, 5),
  "report-export": makePolicy("report-export", 30, FIFTEEN_MINUTES, 4),
};

const classifyRequest = (req: Request): PrivateLimitClass => {
  const path = req.originalUrl.toLowerCase();
  if (
    path.includes("/data-export") ||
    path.includes("/report") ||
    path.includes("/export")
  ) {
    return "report-export";
  }
  return req.method === "GET" || req.method === "HEAD"
    ? "private-read"
    : "private-write";
};

const secondsUntil = (resetTime: Date | undefined): number =>
  Math.max(1, Math.ceil(((resetTime?.getTime() ?? Date.now() + MINUTE) - Date.now()) / 1_000));

const setRateHeaders = (
  res: Response,
  limit: number,
  totalHits: number,
  resetTime: Date | undefined,
): void => {
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - totalHits)));
  res.setHeader("RateLimit-Reset", String(secondsUntil(resetTime)));
};

/**
 * Apply a tenant+user limiter after checkAuth has resolved req.user. A second,
 * looser hashed-IP counter prevents one source from fanning out over many
 * accounts. Raw tenant/user/IP values never appear in Redis keys because
 * RedisRateLimitStore hashes every limiter key before storage.
 */
export async function enforcePrivateApiRateLimit(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user?.id) return;

  const bucket = classifyRequest(req);
  const policy = POLICIES[bucket];
  const tenantId = user.adminId ?? user.id;
  const principalKey = `tenant:${tenantId}:user:${user.id}`;

  const principal = await policy.store.increment(principalKey);
  setRateHeaders(res, policy.limit, principal.totalHits, principal.resetTime);

  if (principal.totalHits > policy.limit) {
    const retryAfter = secondsUntil(principal.resetTime);
    res.setHeader("Retry-After", String(retryAfter));
    throw new AppError(429, "Too many requests. Please retry shortly.", {
      code: "PRIVATE_RATE_LIMITED",
      retryable: true,
    });
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const ipLimit = policy.limit * policy.ipMultiplier;
  const ipCounter = await policy.ipStore.increment(`ip:${ip}`);
  if (ipCounter.totalHits > ipLimit) {
    const retryAfter = secondsUntil(ipCounter.resetTime);
    res.setHeader("Retry-After", String(retryAfter));
    throw new AppError(429, "Too many requests from this network. Please retry shortly.", {
      code: "PRIVATE_RATE_LIMITED",
      retryable: true,
    });
  }
}
