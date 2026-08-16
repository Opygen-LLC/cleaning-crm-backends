import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";

const CACHE_VERSION = 1 as const;
const KEY_PREFIX = "site-projection:";
const DEFAULT_TTL_SECONDS = Math.max(
  30,
  Number(process.env.WEBSITE_PROJECTION_CACHE_TTL_SECONDS) || 120,
);

interface ProjectionCacheEnvelope<T> {
  version: typeof CACHE_VERSION;
  websiteId: string;
  cachedAt: string;
  data: T;
}

const keyFor = (websiteId: string) => `${KEY_PREFIX}${websiteId}`;

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
    await redis.set(keyFor(websiteId), JSON.stringify(envelope), "EX", DEFAULT_TTL_SECONDS);
  } catch {
    // Cache failure must never fail a public website request.
  }
};

const invalidateWebsite = async (websiteId: string | null | undefined): Promise<void> => {
  if (!websiteId) return;
  try {
    await redis.del(keyFor(websiteId));
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
  invalidateWebsite,
  invalidateAdminWebsite,
};
