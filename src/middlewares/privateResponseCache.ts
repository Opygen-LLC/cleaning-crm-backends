import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import redis from "../config/redis";
import { API_RESPONSE_CACHE_TTL_SECONDS } from "../config/ENV";
import logger from "../lib/logger";
import { recordTraceResponseCache } from "../lib/monitoring/requestTrace";

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
const scopePrefix = (tenantId: string) => `http-response:${tenantId}:`;
const cacheIndexKey = (tenantId: string) => `http-response-index:${tenantId}`;
const userIndexKey = (userId: string) => `http-response-user-index:${userId}`;

const cacheKey = (req: Request): string => {
  const routeHash = createHash("sha256")
    .update(req.originalUrl)
    .digest("hex")
    .slice(0, 32);
  const tenant = tenantScope(req);
  const user = userScope(req);
  return `${scopePrefix(tenant)}${user}:${routeHash}`;
};

const isCacheableRequest = (req: Request): boolean =>
  req.method === "GET" &&
  !req.headers.range &&
  !req.originalUrl.includes("/auth/") &&
  !req.originalUrl.includes("/session") &&
  !req.originalUrl.includes("/pdf") &&
  !req.originalUrl.includes("/export");

const ttlFor = (req: Request): number => {
  if (req.originalUrl.includes("/notification/inbox")) return 5;
  if (req.originalUrl.includes("/dashboard/")) {
    return Math.max(60, API_RESPONSE_CACHE_TTL_SECONDS);
  }
  return API_RESPONSE_CACHE_TTL_SECONDS;
};

const parseSharedEntry = (raw: string): CachedResponse | null => {
  try {
    const value = JSON.parse(raw) as CachedResponse;
    return typeof value.body === "string" && typeof value.etag === "string"
      ? value
      : null;
  } catch {
    return null;
  }
};

const sendHit = (
  req: Request,
  res: Response,
  entry: CachedResponse,
): void => {
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

/**
 * Cache keys are indexed per tenant/user at write time. Invalidating a tenant
 * scans only that tenant's indexed Redis set instead of scanning the entire
 * keyspace. When data changes, all old cached responses are unlinked and
 * subsequent requests fetch fresh data from the DB and cache the new data again.
 */
async function deleteIndexedResponses(indexKey: string): Promise<void> {
  let cursor = "0";

  do {
    const [next, keys] = await redis.sscan(
      indexKey,
      cursor,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length) await redis.unlink(...keys);
  } while (cursor !== "0");

  await redis.del(indexKey);
}

export function invalidatePrivateResponseCache(tenantId: string): void {
  void deleteIndexedResponses(cacheIndexKey(tenantId)).catch((error) => {
    logger.warn(
      `[CACHE] Shared response cache invalidation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export async function invalidatePrivateResponseCacheForUser(userId: string): Promise<void> {
  if (!userId || userId === "anonymous") return;
  try {
    await deleteIndexedResponses(userIndexKey(userId));
  } catch (error) {
    // Cache cleanup must never make logout fail. The short-lived cache entries
    // remain isolated by user id and expire naturally if Redis is unavailable.
    logger.warn(
      `[CACHE] User response cache invalidation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function persistCacheEntry(
  tenantId: string,
  userId: string,
  key: string,
  ttlSeconds: number,
  entry: CachedResponse,
): void {
  const indexKey = cacheIndexKey(tenantId);
  const perUserIndexKey = userIndexKey(userId);
  const indexTtl = Math.max(MIN_INDEX_TTL_SECONDS, ttlSeconds * 2);

  const writes: Promise<unknown>[] = [
    redis.setex(key, ttlSeconds, JSON.stringify(entry)),
    redis.sadd(indexKey, key),
    redis.expire(indexKey, indexTtl),
    redis.sadd(perUserIndexKey, key),
    redis.expire(perUserIndexKey, indexTtl),
  ];

  // Best-effort cache write. These commands are independent of request
  // correctness, so Redis trouble must never fail an otherwise valid API call.
  void Promise.all(writes).catch((error) => {
    logger.warn(
      `[CACHE] Shared response cache write skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * Per-user Redis response cache. It runs after authorization, so cached data
 * is strictly isolated to the authenticated user_id. Mutations immediately
 * invalidate the cache so subsequent reads reflect fresh database state.
 */
export async function privateResponseCache(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = tenantScope(req);
  const userId = userScope(req);

  if (!isCacheableRequest(req)) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.once("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          invalidatePrivateResponseCache(tenantId);
        }
      });
    }
    next();
    return;
  }

  const key = cacheKey(req);
  const ttlSeconds = ttlFor(req);
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
      const entry: CachedResponse = {
        body: serialized,
        contentType,
        etag,
        statusCode: res.statusCode,
      };
      res.setHeader("ETag", etag);
      persistCacheEntry(tenantId, userId, key, ttlSeconds, entry);
    }

    return originalSend(body);
  }) as Response["send"];

  next();
}
