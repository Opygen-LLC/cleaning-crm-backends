import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import redis from "../config/redis";
import {
  API_RESPONSE_CACHE_MAX_BYTES,
  API_RESPONSE_CACHE_MAX_ENTRIES,
  API_RESPONSE_CACHE_TTL_SECONDS,
} from "../config/ENV";
import logger from "../lib/logger";
import { BoundedTtlCache } from "../lib/cache/boundedTtlCache";

interface CachedResponse {
  body: string;
  contentType: string;
  etag: string;
  statusCode: number;
}

const l1 = new BoundedTtlCache<CachedResponse>({
  maxEntries: API_RESPONSE_CACHE_MAX_ENTRIES,
  maxBytes: API_RESPONSE_CACHE_MAX_BYTES,
});

const MAX_CACHEABLE_BODY_BYTES = 2 * 1024 * 1024;

const tenantScope = (req: Request) => req.user.adminId ?? req.user.id;
const userScope = (req: Request) => req.user.id;
const scopePrefix = (tenantId: string) => `http-response:${tenantId}:`;

const cacheKey = (req: Request): string => {
  const routeHash = createHash("sha256")
    .update(req.originalUrl)
    .digest("hex")
    .slice(0, 32);
  return `${scopePrefix(tenantScope(req))}${userScope(req)}:${routeHash}`;
};

const isCacheableRequest = (req: Request): boolean =>
  req.method === "GET" &&
  !req.headers.range &&
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
  layer: "L1" | "REDIS",
): void => {
  res.setHeader("X-Response-Cache", `HIT-${layer}`);
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.setHeader("ETag", entry.etag);
  res.type(entry.contentType);

  if (req.headers["if-none-match"] === entry.etag) {
    res.status(304).end();
    return;
  }
  res.status(entry.statusCode).send(entry.body);
};

async function deleteRedisPattern(pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length) await redis.unlink(...keys);
  } while (cursor !== "0");
}

export function invalidatePrivateResponseCache(tenantId: string): void {
  const prefix = scopePrefix(tenantId);
  l1.deleteByPrefix(prefix);
  void deleteRedisPattern(`${prefix}*`).catch((error) => {
    logger.warn(
      `[CACHE] Shared response cache invalidation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * Per-user HTTP microcache. It runs after authorization, so cached data can
 * never cross users or tenants. Mutations invalidate the tenant namespace.
 * A warm L1 hit avoids Redis and Postgres completely and typically completes
 * in single-digit milliseconds.
 */
export async function privateResponseCache(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = tenantScope(req);

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
  const local = l1.get(key);
  if (local) {
    sendHit(req, res, local, "L1");
    return;
  }

  const sharedRaw = await redis.get(key).catch(() => null);
  const shared = sharedRaw ? parseSharedEntry(sharedRaw) : null;
  if (shared) {
    l1.set(key, shared, ttlSeconds * 1_000, Buffer.byteLength(shared.body));
    sendHit(req, res, shared, "REDIS");
    return;
  }

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
      l1.set(key, entry, ttlSeconds * 1_000, bytes);
      void redis
        .setex(key, ttlSeconds, JSON.stringify(entry))
        .catch(() => {});
    }

    return originalSend(body);
  }) as Response["send"];

  next();
}

export const responseCacheTesting = {
  clear: () => l1.clear(),
  size: () => l1.size,
};
