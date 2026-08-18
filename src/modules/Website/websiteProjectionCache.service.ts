import { randomUUID } from "node:crypto";
import {
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO,
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS,
  WEBSITE_PROJECTION_STALE_TTL_SECONDS,
  WEBSITE_PROJECTION_WAIT_FOR_FILL_MS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { PublicWebsiteCacheOutbox } from "../../lib/outbox/publicWebsiteCacheOutbox";
import { prisma } from "../../lib/prisma/prisma";

const CACHE_VERSION = 9 as const;
const KEY_PREFIX = `site-projection:v${CACHE_VERSION}:`;
const STALE_KEY_PREFIX = `site-projection-stale:v${CACHE_VERSION}:`;
const LOCK_PREFIX = `site-projection-lock:v${CACHE_VERSION}:`;
const GENERATION_PREFIX = `site-projection-generation:v${CACHE_VERSION}:`;
const ADMIN_WEBSITE_PREFIX = `site-projection-admin:v${CACHE_VERSION}:`;
const WEBSITE_ADMIN_PREFIX = `site-projection-owner:v${CACHE_VERSION}:`;
const ADMIN_WEBSITE_TTL_SECONDS = 24 * 60 * 60;

interface ProjectionCacheEnvelope<T> {
  version: typeof CACHE_VERSION;
  websiteId: string;
  generation: number;
  cachedAt: string;
  data: T;
}

const keyFor = (websiteId: string) => `${KEY_PREFIX}${websiteId}`;
const staleKeyFor = (websiteId: string) => `${STALE_KEY_PREFIX}${websiteId}`;
const lockKeyFor = (websiteId: string) => `${LOCK_PREFIX}${websiteId}`;
const generationKeyFor = (websiteId: string) => `${GENERATION_PREFIX}${websiteId}`;
const adminWebsiteKeyFor = (adminId: string) => `${ADMIN_WEBSITE_PREFIX}${adminId}`;
const websiteAdminKeyFor = (websiteId: string) => `${WEBSITE_ADMIN_PREFIX}${websiteId}`;

const jitteredTtl = (base = WEBSITE_PROJECTION_CACHE_TTL_SECONDS) => {
  if (WEBSITE_PROJECTION_CACHE_JITTER_RATIO <= 0) return base;
  const spread = base * WEBSITE_PROJECTION_CACHE_JITTER_RATIO;
  const delta = (Math.random() * 2 - 1) * spread;
  return Math.max(30, Math.round(base + delta));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseEnvelope = <T>(raw: string | null, websiteId: string): T | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectionCacheEnvelope<T>;
    if (parsed.version !== CACHE_VERSION || parsed.websiteId !== websiteId) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const safeGetEnvelope = async <T>(key: string, websiteId: string): Promise<T | null> => {
  try {
    return parseEnvelope<T>(await redis.get(key), websiteId);
  } catch {
    return null;
  }
};

const get = <T>(websiteId: string): Promise<T | null> => safeGetEnvelope<T>(keyFor(websiteId), websiteId);
const getStale = <T>(websiteId: string): Promise<T | null> => safeGetEnvelope<T>(staleKeyFor(websiteId), websiteId);

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
 * Compare-and-set both the fresh and stale copies against the generation seen
 * before the PostgreSQL read. A CRM mutation increments that generation and
 * deletes both copies, so an in-flight old query cannot repopulate Redis after
 * invalidation. The stale copy is used only after natural TTL expiry, never
 * after an explicit mutation, and therefore gives us stale-while-revalidate
 * without sacrificing immediate CRM freshness.
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
        local current = redis.call('GET', KEYS[3])
        if not current then current = '0' end
        if current ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
        return 1
      `,
      3,
      keyFor(websiteId),
      staleKeyFor(websiteId),
      generationKeyFor(websiteId),
      String(generation),
      JSON.stringify(envelope),
      String(jitteredTtl()),
      String(jitteredTtl(Math.max(WEBSITE_PROJECTION_STALE_TTL_SECONDS, WEBSITE_PROJECTION_CACHE_TTL_SECONDS + 60))),
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
    // The lock has a short TTL; cleanup must never fail a website request.
  }
};

const loadAndCacheCurrentGeneration = async <T>(websiteId: string, loader: () => Promise<T>): Promise<T> => {
  let generation = await getGeneration(websiteId);
  if (generation === null) return loader();

  let loaded = await loader();
  if (await setForGeneration(websiteId, loaded, generation)) return loaded;

  // A CRM mutation committed while the first DB read was in flight. Reload
  // once from authoritative state and cache only against the new epoch.
  generation = await getGeneration(websiteId);
  if (generation === null) return loader();
  loaded = await loader();
  await setForGeneration(websiteId, loaded, generation);
  return loaded;
};

const waitForFreshFill = async <T>(websiteId: string): Promise<T | null> => {
  const startedAt = Date.now();
  let delay = 20;
  while (Date.now() - startedAt < WEBSITE_PROJECTION_WAIT_FOR_FILL_MS) {
    await sleep(delay);
    const filled = await get<T>(websiteId);
    if (filled) return filled;
    delay = Math.min(180, Math.round(delay * 1.7));
  }
  return null;
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

  // Natural fresh-TTL expiry should not cause hundreds of public requests to
  // queue behind PostgreSQL. Only the lock owner rebuilds; everyone else may
  // serve the longer-lived copy. Explicit CRM invalidation deletes this copy,
  // so service/review/publish changes can never be hidden by stale data.
  const stale = await getStale<T>(websiteId);
  if (stale) return stale;

  // Truly cold cache (new deploy/new tenant): wait briefly for the distributed
  // lock owner. If it still has not filled Redis, fall back to the DB rather
  // than making the public request wait for the entire lock TTL.
  const filled = await waitForFreshFill<T>(websiteId);
  if (filled) return filled;
  return loadAndCacheCurrentGeneration(websiteId, loader);
};

const rememberAdminWebsite = async (adminId: string | null | undefined, websiteId: string | null | undefined): Promise<void> => {
  if (!adminId || !websiteId) return;
  try {
    await Promise.all([
      redis.set(adminWebsiteKeyFor(adminId), websiteId, "EX", ADMIN_WEBSITE_TTL_SECONDS),
      redis.set(websiteAdminKeyFor(websiteId), adminId, "EX", ADMIN_WEBSITE_TTL_SECONDS),
    ]);
  } catch {
    // Optimization only; callers fall back to Prisma.
  }
};

const getAdminIdForWebsite = async (websiteId: string): Promise<string | null> => {
  try {
    const cached = await redis.get(websiteAdminKeyFor(websiteId));
    if (cached) return cached;
  } catch {
    // Fall through to the authoritative DB lookup.
  }

  try {
    const website = await prisma.businessWebsite.findUnique({
      where: { id: websiteId },
      select: { id: true, adminId: true },
    });
    if (!website) return null;
    await rememberAdminWebsite(website.adminId, website.id);
    return website.adminId;
  } catch {
    return null;
  }
};

const invalidateWebsite = async (websiteId: string | null | undefined): Promise<void> => {
  if (!websiteId) return;
  try {
    // Generation bump + fresh/stale/lock deletion are atomic. This closes the
    // stale-repopulation race and guarantees CRM writes are visible on the next
    // public request even though natural TTL expiry can use stale-while-rebuild.
    await redis.eval(
      `
        redis.call('INCR', KEYS[4])
        redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
        return 1
      `,
      4,
      keyFor(websiteId),
      staleKeyFor(websiteId),
      lockKeyFor(websiteId),
      generationKeyFor(websiteId),
    );
  } catch {
    // Redis remains an acceleration layer. PostgreSQL mutations must succeed
    // even during a cache outage; normal TTL expiry provides eventual refresh.
  }

  // The Next.js public projection cache is a second acceleration layer. Queue
  // revalidation after every explicit projection invalidation so ServiceCatalog,
  // published Review, BookingForm, domain/subdomain and Publish writes all share
  // one correctness boundary. The outbox helper is non-throwing; its one-hour
  // frontend safety window is the fallback if this durable event cannot queue.
  await PublicWebsiteCacheOutbox.enqueue({ websiteId });
};

const invalidateAdminWebsite = async (adminId: string | null | undefined): Promise<void> => {
  if (!adminId) return;
  try {
    // The public loader remembers this one-to-one relation. On warm tenants a
    // CRM mutation therefore invalidates Redis without an extra SQL lookup.
    const cachedWebsiteId = await redis.get(adminWebsiteKeyFor(adminId));
    if (cachedWebsiteId) {
      await invalidateWebsite(cachedWebsiteId);
      return;
    }
  } catch {
    // Fall through to the authoritative DB lookup.
  }

  try {
    const website = await prisma.businessWebsite.findUnique({
      where: { adminId },
      select: { id: true },
    });
    if (!website) return;
    await rememberAdminWebsite(adminId, website.id);
    await invalidateWebsite(website.id);
  } catch {
    // Never turn a successful CRM mutation into a failure due to cache cleanup.
  }
};

export const WebsiteProjectionCacheService = {
  get,
  set,
  getOrLoad,
  rememberAdminWebsite,
  getAdminIdForWebsite,
  invalidateWebsite,
  invalidateAdminWebsite,
};
