import { randomUUID } from "node:crypto";
import {
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO,
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS,
  WEBSITE_PROJECTION_STALE_TTL_SECONDS,
  WEBSITE_PROJECTION_WAIT_FOR_FILL_MS,
  WEBSITE_STUDIO_CACHE_TTL_SECONDS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { PublicWebsiteCacheRevalidation } from "../../lib/outbox/publicWebsiteCacheOutbox";
import { CacheNamespaces, ttlForKey } from "../../lib/cache/cachePolicy";
import { singleFlight } from "../../lib/utils/singleFlight";
import { WEBSITE_EDITOR_SURFACES, type WebsiteEditorSurface } from "./website.interface";
import { prisma } from "../../lib/prisma/prisma";
import { TenantAccessResolver, type TenantAccessResolution } from "../Entitlement/tenantAccessResolver.service";

const CACHE_VERSION = 11 as const;
const STALE_KEY_PREFIX = `site-projection-stale:v${CACHE_VERSION}:`;
const LOCK_PREFIX = `site-projection-lock:v${CACHE_VERSION}:`;
const GENERATION_PREFIX = `site-projection-generation:v${CACHE_VERSION}:`;
const ADMIN_WEBSITE_PREFIX = `site-projection-admin:v${CACHE_VERSION}:`;
const WEBSITE_ADMIN_PREFIX = `site-projection-owner:v${CACHE_VERSION}:`;
const ADMIN_WEBSITE_TTL_SECONDS = 24 * 60 * 60;
const STUDIO_CACHE_VERSION = 1 as const;
const STUDIO_CACHE_SURFACES = [...WEBSITE_EDITOR_SURFACES] as const;

interface StudioCacheEnvelope<T> {
  version: typeof STUDIO_CACHE_VERSION;
  cachedAt: string;
  data: T;
}

type ProjectionAccess = Pick<TenantAccessResolution, "organizationId" | "generation" | "validUntil">;

interface ProjectionCacheEnvelope<T> {
  access?: ProjectionAccess;
  version: typeof CACHE_VERSION;
  websiteId: string;
  generation: number;
  cachedAt: string;
  data: T;
}

const keyFor = (websiteId: string) => CacheNamespaces.websiteProjection(websiteId);
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

const parseEnvelope = async <T>(raw: string | null, websiteId: string): Promise<T | null> => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectionCacheEnvelope<T>;
    if (parsed.version !== CACHE_VERSION || parsed.websiteId !== websiteId) return null;
    // Legacy/access-less envelopes are data, not authorization evidence.
    if (!parsed.access?.organizationId || !parsed.access.generation ||
        !Number.isFinite(Date.parse(parsed.access.validUntil)) ||
        Date.parse(parsed.access.validUntil) <= Date.now() ||
        !await TenantAccessResolver.isCurrentGeneration(parsed.access.organizationId, parsed.access.generation)) return null;
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
const setForGeneration = async <T>(websiteId: string, data: T, generation: number, access?: ProjectionAccess): Promise<boolean> => {
  if (!access?.organizationId || !access.generation) return false;
  const envelope: ProjectionCacheEnvelope<T> = {
    version: CACHE_VERSION,
    websiteId,
    generation,
    access,
    cachedAt: new Date().toISOString(),
    data,
  };
  try {
    const remaining = access ? Math.floor(Date.parse(access.validUntil) - Date.now()) : Number.MAX_SAFE_INTEGER;
    if (access && (!Number.isFinite(remaining) || remaining <= 0 ||
        !await TenantAccessResolver.isCurrentGeneration(access.organizationId, access.generation))) return false;
    const freshTtl = Math.min(jitteredTtl() * 1000, remaining);
    const staleTtl = Math.min(jitteredTtl(Math.max(WEBSITE_PROJECTION_STALE_TTL_SECONDS, WEBSITE_PROJECTION_CACHE_TTL_SECONDS + 60)) * 1000, remaining);
    const result = await redis.eval(
      `
        local current = redis.call('GET', KEYS[3])
        if not current then current = '0' end
        if current ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
        redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[4])
        return 1
      `,
      3,
      keyFor(websiteId),
      staleKeyFor(websiteId),
      generationKeyFor(websiteId),
      String(generation),
      JSON.stringify(envelope),
      String(freshTtl),
      String(staleTtl),
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
};

const set = async <T>(websiteId: string, data: T): Promise<boolean> => {
  const generation = await getGeneration(websiteId);
  if (generation === null) return false;
  const adminId = await getAdminIdForWebsite(websiteId);
  if (!adminId) return false;
  try {
    const access = await TenantAccessResolver.resolve(adminId, { authoritative: true });
    if (!access.access.publicWebsiteAllowed) return false;
    return setForGeneration(websiteId, data, generation, access);
  } catch {
    return false;
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
    // The lock has a short TTL; cleanup must never fail a website request.
  }
};

const loadAndCacheCurrentGeneration = async <T>(websiteId: string, loader: () => Promise<T>, access?: ProjectionAccess): Promise<T> => {
  let generation = await getGeneration(websiteId);
  if (generation === null) return loader();

  let loaded = await loader();
  if (await setForGeneration(websiteId, loaded, generation, access)) return loaded;

  // A CRM mutation committed while the first DB read was in flight. Reload
  // once from authoritative state and cache only against the new epoch.
  generation = await getGeneration(websiteId);
  if (generation === null) return loader();
  loaded = await loader();
  await setForGeneration(websiteId, loaded, generation, access);
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

const getOrLoad = async <T>(websiteId: string, loader: () => Promise<T>, access?: ProjectionAccess): Promise<T> => {
  const cached = await get<T>(websiteId);
  if (cached) return cached;

  const lock = await acquireRebuildLock(websiteId);
  if (lock.token) {
    try {
      const filled = await get<T>(websiteId);
      if (filled) return filled;
      return await loadAndCacheCurrentGeneration(websiteId, loader, access);
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
  return loadAndCacheCurrentGeneration(websiteId, loader, access);
};

const studioKeyFor = (adminId: string, surface: WebsiteEditorSurface) =>
  CacheNamespaces.websiteStudio(adminId, surface);

const getStudio = async <T>(adminId: string, surface: WebsiteEditorSurface): Promise<T | null> => {
  try {
    const raw = await redis.get(studioKeyFor(adminId, surface));
    if (!raw) return null;
    const envelope = JSON.parse(raw) as StudioCacheEnvelope<T>;
    if (envelope.version !== STUDIO_CACHE_VERSION) return null;
    return envelope.data;
  } catch {
    return null;
  }
};

const setStudio = async <T>(adminId: string, surface: WebsiteEditorSurface, data: T): Promise<void> => {
  const key = studioKeyFor(adminId, surface);
  const envelope: StudioCacheEnvelope<T> = {
    version: STUDIO_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    data,
  };
  try {
    await redis.setex(key, ttlForKey(WEBSITE_STUDIO_CACHE_TTL_SECONDS, key), JSON.stringify(envelope));
  } catch {
    // PostgreSQL remains authoritative during a Redis outage.
  }
};

const getOrLoadStudio = async <T>(
  adminId: string,
  surface: WebsiteEditorSurface,
  loader: () => Promise<T>,
): Promise<T> => {
  const cached = await getStudio<T>(adminId, surface);
  if (cached) return cached;

  return singleFlight(`website-studio:${adminId}:${surface}`, async () => {
    const filled = await getStudio<T>(adminId, surface);
    if (filled) return filled;
    const loaded = await loader();
    await setStudio(adminId, surface, loaded);
    return loaded;
  });
};

const invalidateStudioAdmin = async (adminId: string | null | undefined): Promise<boolean> => {
  if (!adminId) return true;
  try {
    await redis.del(
      ...STUDIO_CACHE_SURFACES.map((surface) => studioKeyFor(adminId, surface)),
      CacheNamespaces.websiteStudioOverview(adminId),
    );
    return true;
  } catch {
    return false;
  }
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

export interface WebsiteProjectionInvalidationOptions {
  /**
   * Publish/Launch set this to false so they can invalidate routing first and
   * then trigger Next.js explicitly with the canonical tenant identifiers.
   */
  revalidateNext?: boolean;
  tenantIdentifier?: string | null;
  tenantIdentifiers?: string[] | null;
  reason?: string | null;
}

export interface WebsiteProjectionInvalidationResult {
  invalidated: boolean;
  publicProjectionInvalidated: boolean;
  studioInvalidated: boolean;
  revalidation: Awaited<ReturnType<typeof PublicWebsiteCacheRevalidation.triggerWithFallback>> | null;
}

const invalidateWebsite = async (
  websiteId: string | null | undefined,
  knownAdminId?: string | null,
  options: WebsiteProjectionInvalidationOptions = {},
): Promise<WebsiteProjectionInvalidationResult> => {
  if (!websiteId) return { invalidated: false, publicProjectionInvalidated: false, studioInvalidated: false, revalidation: null };
  let publicProjectionInvalidated = false;
  const adminId = knownAdminId !== undefined ? knownAdminId : await getAdminIdForWebsite(websiteId);
  try {
    // Generation bump + fresh/stale/lock deletion are atomic. This closes the
    // stale-repopulation race and guarantees CRM writes are visible on the next
    // public request even though natural TTL expiry can use stale-while-rebuild.
    const result = await redis.eval(
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
    publicProjectionInvalidated = Number(result) === 1;
  } catch {
    // Redis remains an acceleration layer. PostgreSQL mutations must succeed
    // even during a cache outage; the Next.js safety TTL still provides eventual refresh.
  }

  const studioInvalidated = await invalidateStudioAdmin(adminId);
  let revalidation: WebsiteProjectionInvalidationResult["revalidation"] = null;

  // Every public projection mutation still has a direct Next.js correctness
  // boundary. Publish/Launch defer only this step so routing + Redis can be
  // invalidated first and the richer tenant/alias payload can be sent afterward.
  if (options.revalidateNext !== false) {
    revalidation = await PublicWebsiteCacheRevalidation.triggerWithFallback({
      websiteId,
      tenantIdentifier: options.tenantIdentifier,
      tenantIdentifiers: options.tenantIdentifiers,
      reason: options.reason ?? "website-projection-invalidated",
    });
  }
  return { invalidated: publicProjectionInvalidated && studioInvalidated, publicProjectionInvalidated, studioInvalidated, revalidation };
};

const invalidateAdminWebsite = async (adminId: string | null | undefined): Promise<boolean> => {
  if (!adminId) return false;
  try {
    let websiteId: string | null = null;
    try { websiteId = await redis.get(adminWebsiteKeyFor(adminId)); } catch { /* Fall back to SQL. */ }
    if (!websiteId) {
      const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
      if (!website) return invalidateStudioAdmin(adminId);
      websiteId = website.id;
      await rememberAdminWebsite(adminId, websiteId);
    }
    const result = await invalidateWebsite(websiteId, adminId);
    return result.invalidated && (result.revalidation === null || result.revalidation.delivered);
  } catch {
    // The database mutation has succeeded, but cleanup has not been confirmed.
    return false;
  }
};

export const WebsiteProjectionCacheService = {
  get,
  set,
  getOrLoad,
  getStudio,
  setStudio,
  getOrLoadStudio,
  invalidateStudioAdmin,
  rememberAdminWebsite,
  getAdminIdForWebsite,
  invalidateWebsite,
  invalidateAdminWebsite,
};
