import { randomUUID } from "node:crypto";
import {
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO,
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";

const CACHE_VERSION = 4 as const;
const KEY_PREFIX = `site-projection:v${CACHE_VERSION}:`;
const LOCK_PREFIX = `site-projection-lock:v${CACHE_VERSION}:`;

interface ProjectionCacheEnvelope<T> {
  version: typeof CACHE_VERSION;
  websiteId: string;
  cachedAt: string;
  data: T;
}

const keyFor = (websiteId: string) => `${KEY_PREFIX}${websiteId}`;
const lockKeyFor = (websiteId: string) => `${LOCK_PREFIX}${websiteId}`;

const jitteredTtl = () => {
  if (WEBSITE_PROJECTION_CACHE_JITTER_RATIO <= 0) return WEBSITE_PROJECTION_CACHE_TTL_SECONDS;
  const spread = WEBSITE_PROJECTION_CACHE_TTL_SECONDS * WEBSITE_PROJECTION_CACHE_JITTER_RATIO;
  const delta = (Math.random() * 2 - 1) * spread;
  return Math.max(30, Math.round(WEBSITE_PROJECTION_CACHE_TTL_SECONDS + delta));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const get = async <T>(websiteId: string): Promise<T | null> => {
  try {
    const raw = await redis.get(keyFor(websiteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectionCacheEnvelope<T>;
    if (parsed.version !== CACHE_VERSION || parsed.websiteId !== websiteId) return null;
    return parsed.data;
  } catch {
    // Redis is an acceleration layer only. Public sites must continue to work
    // from PostgreSQL when Redis is unavailable or contains a malformed value.
    return null;
  }
};

const set = async <T>(websiteId: string, data: T): Promise<void> => {
  const envelope: ProjectionCacheEnvelope<T> = {
    version: CACHE_VERSION,
    websiteId,
    cachedAt: new Date().toISOString(),
    data,
  };
  try {
    await redis.set(keyFor(websiteId), JSON.stringify(envelope), "EX", jitteredTtl());
  } catch {
    // Cache failure must never fail a public website request.
  }
};

const acquireRebuildLock = async (websiteId: string): Promise<{ token: string | null; redisAvailable: boolean }> => {
  const token = randomUUID();
  try {
    const result = await redis.set(
      lockKeyFor(websiteId),
      token,
      "EX",
      WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS,
      "NX",
    );
    return { token: result === "OK" ? token : null, redisAvailable: true };
  } catch {
    return { token: null, redisAvailable: false };
  }
};

const releaseRebuildLock = async (websiteId: string, token: string): Promise<void> => {
  try {
    await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      lockKeyFor(websiteId),
      token,
    );
  } catch {
    // The lock has a short TTL and is only a stampede guard. Never fail the
    // public request if Redis disappears after the rebuild has completed.
  }
};

/**
 * Read-through public projection cache with distributed rebuild suppression.
 * A cold tenant should cause one PostgreSQL projection build across the API
 * fleet, not one build per concurrent request/replica. If Redis is unavailable
 * the loader still runs directly, preserving correctness and availability.
 */
const getOrLoad = async <T>(websiteId: string, loader: () => Promise<T>): Promise<T> => {
  const cached = await get<T>(websiteId);
  if (cached) return cached;

  const lock = await acquireRebuildLock(websiteId);
  if (lock.token) {
    try {
      // Double-check after acquiring the lock: another request may have filled
      // the cache between our first GET and SET NX.
      const filled = await get<T>(websiteId);
      if (filled) return filled;
      const loaded = await loader();
      await set(websiteId, loaded);
      return loaded;
    } finally {
      await releaseRebuildLock(websiteId, lock.token);
    }
  }

  // If Redis itself is unavailable, waiting cannot discover another replica's
  // result. Go directly to PostgreSQL rather than adding artificial latency.
  if (!lock.redisAvailable) {
    const loaded = await loader();
    await set(websiteId, loaded);
    return loaded;
  }

  // Another replica is rebuilding. Wait briefly for its result instead of
  // immediately stampeding PostgreSQL. The total wait remains below 400 ms;
  // after that we fail open to the loader so Redis contention cannot stall a
  // public site indefinitely.
  for (const delayMs of [25, 50, 100, 150]) {
    await sleep(delayMs);
    const filled = await get<T>(websiteId);
    if (filled) return filled;
  }

  const loaded = await loader();
  await set(websiteId, loaded);
  return loaded;
};

const invalidateWebsite = async (websiteId: string | null | undefined): Promise<void> => {
  if (!websiteId) return;
  try {
    await redis.del(keyFor(websiteId), lockKeyFor(websiteId));
  } catch {
    // Mutations remain authoritative even if invalidation cannot reach Redis.
  }
};

const invalidateAdminWebsite = async (adminId: string | null | undefined): Promise<void> => {
  if (!adminId) return;
  try {
    const website = await prisma.businessWebsite.findUnique({
      where: { adminId },
      select: { id: true },
    });
    if (website) await invalidateWebsite(website.id);
  } catch {
    // Never turn an otherwise-successful CRM mutation into a failure because a
    // best-effort public cache invalidation could not be completed.
  }
};

export const WebsiteProjectionCacheService = {
  get,
  set,
  getOrLoad,
  invalidateWebsite,
  invalidateAdminWebsite,
};
