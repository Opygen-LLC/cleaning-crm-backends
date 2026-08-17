import { randomUUID } from "node:crypto";
import {
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO,
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";

const CACHE_VERSION = 8 as const;
const KEY_PREFIX = `site-projection:v${CACHE_VERSION}:`;
const LOCK_PREFIX = `site-projection-lock:v${CACHE_VERSION}:`;
const GENERATION_PREFIX = `site-projection-generation:v${CACHE_VERSION}:`;

interface ProjectionCacheEnvelope<T> {
  version: typeof CACHE_VERSION;
  websiteId: string;
  generation: number;
  cachedAt: string;
  data: T;
}

const keyFor = (websiteId: string) => `${KEY_PREFIX}${websiteId}`;
const lockKeyFor = (websiteId: string) => `${LOCK_PREFIX}${websiteId}`;
const generationKeyFor = (websiteId: string) => `${GENERATION_PREFIX}${websiteId}`;

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
    return null;
  }
};

const getGeneration = async (websiteId: string): Promise<number | null> => {
  try {
    const raw = await redis.get(generationKeyFor(websiteId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return null;
  }
};

/**
 * Compare-and-set the projection against the generation observed before the
 * PostgreSQL load. If a CRM mutation invalidates the website while a cold
 * projection is being built, the stale loader is forbidden from re-inserting
 * its old result after invalidation.
 */
const setForGeneration = async <T>(websiteId: string, data: T, generation: number): Promise<boolean> => {
  const envelope: ProjectionCacheEnvelope<T> = {
    version: CACHE_VERSION,
    websiteId,
    generation,
    cachedAt: new Date().toISOString(),
    data,
  };
  try {
    const result = await redis.eval(
      `
        local current = redis.call('GET', KEYS[2])
        if not current then current = '0' end
        if current ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
        return 1
      `,
      2,
      keyFor(websiteId),
      generationKeyFor(websiteId),
      String(generation),
      JSON.stringify(envelope),
      String(jitteredTtl()),
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
};

const set = async <T>(websiteId: string, data: T): Promise<void> => {
  const generation = await getGeneration(websiteId);
  if (generation === null) return;
  await setForGeneration(websiteId, data, generation);
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
    // Short-lived lock; never fail a website request on cleanup.
  }
};

const loadAndCacheCurrentGeneration = async <T>(websiteId: string, loader: () => Promise<T>): Promise<T> => {
  let generation = await getGeneration(websiteId);
  if (generation === null) return loader();

  let loaded = await loader();
  if (await setForGeneration(websiteId, loaded, generation)) return loaded;

  // A CRM mutation committed while the first DB read was in flight. Reload
  // once from the authoritative DB state and cache only against the new epoch.
  generation = await getGeneration(websiteId);
  if (generation === null) return loader();
  loaded = await loader();
  await setForGeneration(websiteId, loaded, generation);
  return loaded;
};

const getOrLoad = async <T>(websiteId: string, loader: () => Promise<T>): Promise<T> => {
  const cached = await get<T>(websiteId);
  if (cached) return cached;

  const lock = await acquireRebuildLock(websiteId);
  if (lock.token) {
    try {
      const filled = await get<T>(websiteId);
      if (filled) return filled;
      return await loadAndCacheCurrentGeneration(websiteId, loader);
    } finally {
      await releaseRebuildLock(websiteId, lock.token);
    }
  }

  if (!lock.redisAvailable) return loader();

  for (const delayMs of [25, 50, 100, 150]) {
    await sleep(delayMs);
    const filled = await get<T>(websiteId);
    if (filled) return filled;
  }

  return loadAndCacheCurrentGeneration(websiteId, loader);
};

const invalidateWebsite = async (websiteId: string | null | undefined): Promise<void> => {
  if (!websiteId) return;
  try {
    // Generation bump + cache deletion are atomic. This closes the classic
    // stale-repopulation race between a concurrent cache miss and a CRM write.
    await redis.eval(
      `
        redis.call('INCR', KEYS[3])
        redis.call('DEL', KEYS[1], KEYS[2])
        return 1
      `,
      3,
      keyFor(websiteId),
      lockKeyFor(websiteId),
      generationKeyFor(websiteId),
    );
  } catch {
    // Redis remains an acceleration layer. PostgreSQL mutations must succeed
    // even during a cache outage; normal TTL expiry provides eventual refresh.
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
    // Never turn a successful CRM mutation into a failure due to cache cleanup.
  }
};

export const WebsiteProjectionCacheService = {
  get,
  set,
  getOrLoad,
  invalidateWebsite,
  invalidateAdminWebsite,
};
