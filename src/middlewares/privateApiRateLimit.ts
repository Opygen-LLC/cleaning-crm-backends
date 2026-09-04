import type { Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import { RedisRateLimitStore } from "../lib/rateLimit/redisRateLimitStore";
import { extractClientIp, extractDeviceIdentifier } from "../lib/rateLimit/deviceIdentifier";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const FIFTEEN_MINUTES = 15 * MINUTE;

type PrivateLimitClass = "private-read" | "private-write" | "report-export";

interface LimitPolicy {
  limit: number;
  windowMs: number;
  store: RedisRateLimitStore;
  deviceStore: RedisRateLimitStore;
  ipStore: RedisRateLimitStore;
  ipMultiplier: number;
  deviceMultiplier: number;
}

const makePolicy = (
  name: PrivateLimitClass,
  limit: number,
  windowMs: number,
  ipMultiplier = 4,
  deviceMultiplier = 2,
): LimitPolicy => ({
  limit,
  windowMs,
  store: new RedisRateLimitStore({ prefix: name, windowMs }),
  deviceStore: new RedisRateLimitStore({ prefix: `${name}:device`, windowMs }),
  ipStore: new RedisRateLimitStore({ prefix: `${name}:ip`, windowMs }),
  ipMultiplier,
  deviceMultiplier,
});

/**
 * Authenticated dashboard traffic is intentionally given generous ceilings.
 * These limits protect expensive endpoints from runaway polling/automation
 * without turning ordinary navigation, RTK revalidation, or multi-tab use into
 * 429s. Redis keeps the allowance consistent across API replicas; the shared
 * store's bounded local fallback keeps protection active during Redis outages.
 */
const POLICIES: Record<PrivateLimitClass, LimitPolicy> = {
  "private-read": makePolicy("private-read", 600, MINUTE, 6, 2),
  "private-write": makePolicy("private-write", 180, MINUTE, 6, 2),
  "report-export": makePolicy("report-export", 30, FIFTEEN_MINUTES, 4, 2),
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
 * Apply a tenant+user limiter after checkAuth has resolved req.user.
 * Additional device and hashed-IP counters prevent one client or network
 * from fanning out over many accounts or rotating IPs. Raw values never appear
 * in Redis keys because RedisRateLimitStore hashes every limiter key before storage.
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

  // Device-level limiter (protects against IP rotation from the same device)
  const deviceId = extractDeviceIdentifier(req);
  const deviceLimit = Math.ceil(policy.limit * policy.deviceMultiplier);
  const deviceCounter = await policy.deviceStore.increment(`device:${deviceId}`);
  if (deviceCounter.totalHits > deviceLimit) {
    const retryAfter = secondsUntil(deviceCounter.resetTime);
    res.setHeader("Retry-After", String(retryAfter));
    throw new AppError(429, "Too many requests from this device. Please retry shortly.", {
      code: "PRIVATE_RATE_LIMITED",
      retryable: true,
    });
  }

  // Network IP limiter (wide multiplier prevents office NAT false positives)
  const ip = extractClientIp(req);
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
