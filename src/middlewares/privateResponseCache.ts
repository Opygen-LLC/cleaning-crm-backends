import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import redis from "../config/redis";
import logger from "../lib/logger";
import { recordTraceResponseCache } from "../lib/monitoring/requestTrace";
import {
  CacheResource,
  type CacheResourceName,
  getCacheResourceVersion,
} from "../lib/cache/resourceCacheVersion";

interface CachedResponse {
  body: string;
  contentType: string;
  etag: string;
  statusCode: number;
}

const MAX_CACHEABLE_BODY_BYTES = 2 * 1024 * 1024;
const MIN_INDEX_TTL_SECONDS = 60 * 60;

const tenantScope = (req: Request) => req.user?.adminId ?? req.user?.id ?? "global";
const userScope = (req: Request) => req.user?.id ?? "anonymous";
const userIndexKey = (userId: string) => `http-response-user-index:${userId}`;

const resourceForRequest = (req: Request): CacheResourceName | null => {
  const path = req.originalUrl.toLowerCase();
  if (path.includes("/dashboard")) return CacheResource.dashboard;
  if (path.includes("/admin/onboarding-status") || path.includes("/onboarding")) return CacheResource.onboarding;
  if (path.includes("/client")) return CacheResource.clients;
  if (path.includes("/lead/follow-ups")) return CacheResource.followUps;
  if (path.includes("/lead")) return CacheResource.leads;
  if (path.includes("/booking")) return CacheResource.bookings;
  if (path.includes("/job")) return CacheResource.jobs;
  if (path.includes("/staff")) return CacheResource.staff;
  if (path.includes("/invoice")) return CacheResource.invoices;
  if (path.includes("/payment")) return CacheResource.payments;
  if (path.includes("/notification")) return CacheResource.notifications;
  if (path.includes("/report")) return CacheResource.reports;
  if (path.includes("/website")) return CacheResource.website;
  if (path.includes("/quote")) return CacheResource.quotes;
  if (path.includes("/estimate")) return CacheResource.estimates;
  if (path.includes("/admin/profile") || path.includes("/user/me")) return CacheResource.profile;
  if (path.includes("/service")) return CacheResource.services;
  return null;
};

const isLiveAvailabilityRequest = (req: Request) => {
  const path = req.originalUrl.toLowerCase();
  return path.includes("availability") || path.includes("available-slot") || path.includes("available-staff");
};

const isCacheableRequest = (req: Request): boolean =>
  req.method === "GET" &&
  !req.headers.range &&
  !req.originalUrl.includes("/auth/") &&
  !req.originalUrl.includes("/session") &&
  !req.originalUrl.includes("/subscription/me") &&
  !req.originalUrl.includes("/pdf") &&
  !req.originalUrl.includes("/export") &&
  !isLiveAvailabilityRequest(req);

const ttlForResource = (resource: CacheResourceName | null): number => {
  switch (resource) {
    case CacheResource.notifications:
      return 10;
    case CacheResource.clients:
    case CacheResource.leads:
    case CacheResource.followUps:
    case CacheResource.bookings:
    case CacheResource.jobs:
    case CacheResource.staff:
    case CacheResource.dashboard:
    case CacheResource.invoices:
    case CacheResource.payments:
    case CacheResource.quotes:
    case CacheResource.estimates:
      return 45;
    case CacheResource.profile:
    case CacheResource.onboarding:
      return 10 * 60;
    case CacheResource.services:
    case CacheResource.website:
      return 5 * 60;
    case CacheResource.reports:
      return 15 * 60;
    default:
      return 45;
  }
};

const cacheKey = async (req: Request, resource: CacheResourceName | null): Promise<string> => {
  const routeHash = createHash("sha256")
    .update(req.originalUrl)
    .digest("hex")
    .slice(0, 32);
  const tenant = tenantScope(req);
  const user = userScope(req);
  const version = resource ? await getCacheResourceVersion(tenant, resource) : 0;
  const resourceSegment = resource ?? "generic";
  return `http-response:${tenant}:${resourceSegment}:v${version}:${user}:${routeHash}`;
};

const parseSharedEntry = (raw: string): CachedResponse | null => {
  try {
    const value = JSON.parse(raw) as CachedResponse;
    return typeof value.body === "string" && typeof value.etag === "string" ? value : null;
  } catch {
    return null;
  }
};

const sendHit = (req: Request, res: Response, entry: CachedResponse): void => {
  res.setHeader("X-Response-Cache", "HIT-REDIS");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.setHeader("ETag", entry.etag);
  res.type(entry.contentType);

  if (req.headers["if-none-match"] === entry.etag) {
    res.status(304).end();
    return;
  }
  res.status(entry.statusCode).send(entry.body);
};

async function deleteIndexedResponses(indexKey: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.sscan(indexKey, cursor, "COUNT", 100);
    cursor = next;
    if (keys.length) await redis.unlink(...keys);
  } while (cursor !== "0");
  await redis.del(indexKey);
}

/**
 * Logout/profile identity cleanup remains user-indexed because it must remove
 * every cached route belonging to that browser identity immediately.
 * Normal CRM writes use resource generation bumps instead of tenant scans.
 */
export async function invalidatePrivateResponseCacheForUser(userId: string): Promise<void> {
  if (!userId || userId === "anonymous") return;
  try {
    await deleteIndexedResponses(userIndexKey(userId));
  } catch (error) {
    logger.warn(
      `[CACHE] User response cache invalidation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function persistCacheEntry(
  userId: string,
  key: string,
  ttlSeconds: number,
  entry: CachedResponse,
): void {
  const perUserIndexKey = userIndexKey(userId);
  const indexTtl = Math.max(MIN_INDEX_TTL_SECONDS, ttlSeconds * 2);
  const writes: Promise<unknown>[] = [
    redis.setex(key, ttlSeconds, JSON.stringify(entry)),
    redis.sadd(perUserIndexKey, key),
    redis.expire(perUserIndexKey, indexTtl),
  ];

  void Promise.all(writes).catch((error) => {
    logger.warn(
      `[CACHE] Shared response cache write skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * Per-user Redis response cache with tenant/resource generations.
 * Mutations no longer trigger an asynchronous tenant-wide delete from here.
 * Owning controllers bump the exact affected resource generations after their
 * DB transaction succeeds and before sending the mutation response.
 */
export async function privateResponseCache(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isCacheableRequest(req)) {
    next();
    return;
  }

  const resource = resourceForRequest(req);
  const key = await cacheKey(req, resource);
  const ttlSeconds = ttlForResource(resource);
  const sharedRaw = await redis.get(key).catch(() => null);
  const shared = sharedRaw ? parseSharedEntry(sharedRaw) : null;
  if (shared) {
    recordTraceResponseCache("hit");
    sendHit(req, res, shared);
    return;
  }

  recordTraceResponseCache("miss");
  res.setHeader("X-Response-Cache", "MISS");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  const originalSend = res.send.bind(res);
  const userId = userScope(req);

  res.send = ((body: unknown) => {
    const contentType = res.getHeader("Content-Type")?.toString() ?? "";
    const serialized =
      typeof body === "string"
        ? body
        : Buffer.isBuffer(body)
          ? body.toString("utf8")
          : JSON.stringify(body);
    const bytes = Buffer.byteLength(serialized);

    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      contentType.includes("application/json") &&
      bytes <= MAX_CACHEABLE_BODY_BYTES &&
      !res.getHeader("Content-Disposition")
    ) {
      const etag = `W/"${createHash("sha1").update(serialized).digest("base64url")}"`;
      const entry: CachedResponse = { body: serialized, contentType, etag, statusCode: res.statusCode };
      res.setHeader("ETag", etag);
      persistCacheEntry(userId, key, ttlSeconds, entry);
    }

    return originalSend(body);
  }) as Response["send"];

  next();
}
