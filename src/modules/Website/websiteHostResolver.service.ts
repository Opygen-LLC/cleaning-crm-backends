import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeSubdomain } from "./websiteIdentity";

const ROUTE_CACHE_VERSION = 1 as const;
const ROUTE_CACHE_TTL_SECONDS = 300;
const SUBDOMAIN_KEY_PREFIX = "site-subdomain:";
const HOST_KEY_PREFIX = "site-host:";

export interface WebsiteRouteResolution {
  version: typeof ROUTE_CACHE_VERSION;
  websiteId: string;
  requestedSubdomain: string;
  canonicalSubdomain: string;
  isAlias: boolean;
  redirectCode: 308 | null;
}

export interface WebsiteHostResolution extends WebsiteRouteResolution {
  requestedHost: string;
  canonicalHost: string;
}

const subdomainCacheKey = (subdomain: string) => `${SUBDOMAIN_KEY_PREFIX}${subdomain}`;
const hostCacheKey = (host: string) => `${HOST_KEY_PREFIX}${host}`;

const safeGet = async <T>(key: string): Promise<T | null> => {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const safeSet = async (key: string, value: unknown) => {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ROUTE_CACHE_TTL_SECONDS);
  } catch {
    // Redis is a cache only. Database resolution remains authoritative.
  }
};

const safeDelete = async (keys: string[]) => {
  if (!keys.length) return;
  try {
    await redis.del(...keys);
  } catch {
    // Cache invalidation failures must never make a successful rename fail.
  }
};

const normalizeHost = (value: string): string => {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes("@") || host.includes(" ")) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  // The frontend proxy sends a bare hostname, but tolerate a host:port value
  // for local/manual API checks without accepting IPv6/custom-domain routing.
  return host.replace(/:\d+$/, "");
};

const parsePlatformSubdomain = (host: string): string => {
  if (!WEBSITE_BASE_DOMAIN) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website host routing is not configured");
  }

  const suffix = `.${WEBSITE_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) throw new AppError(status.NOT_FOUND, "Website host not found");

  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) throw new AppError(status.NOT_FOUND, "Website host not found");

  try {
    return normalizeSubdomain(label);
  } catch {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
};

/**
 * Resolve one tenant label to its website. Aliases always point directly to the
 * current website row, so renaming repeatedly never creates redirect chains.
 * Misses are intentionally not cached: a just-provisioned tenant becomes live
 * immediately and does not wait for a negative-cache TTL to expire.
 */
const resolveSubdomain = async (input: string): Promise<WebsiteRouteResolution> => {
  let subdomain: string;
  try {
    subdomain = normalizeSubdomain(input);
  } catch {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const cached = await safeGet<WebsiteRouteResolution>(subdomainCacheKey(subdomain));
  if (cached?.version === ROUTE_CACHE_VERSION && cached.requestedSubdomain === subdomain) {
    return cached;
  }

  const website = await prisma.businessWebsite.findUnique({
    where: { subdomain },
    select: { id: true, subdomain: true },
  });
  if (website) {
    const resolved: WebsiteRouteResolution = {
      version: ROUTE_CACHE_VERSION,
      websiteId: website.id,
      requestedSubdomain: subdomain,
      canonicalSubdomain: website.subdomain,
      isAlias: false,
      redirectCode: null,
    };
    await safeSet(subdomainCacheKey(subdomain), resolved);
    return resolved;
  }

  const alias = await prisma.websiteSubdomainAlias.findUnique({
    where: { subdomain },
    select: {
      websiteId: true,
      redirectCode: true,
      website: { select: { subdomain: true } },
    },
  });
  if (!alias) throw new AppError(status.NOT_FOUND, "Website not found");

  const resolved: WebsiteRouteResolution = {
    version: ROUTE_CACHE_VERSION,
    websiteId: alias.websiteId,
    requestedSubdomain: subdomain,
    canonicalSubdomain: alias.website.subdomain,
    isAlias: true,
    // Phase 6 only supports permanent aliases. Do not trust an unexpected DB
    // value to turn this public redirect into a different status code.
    redirectCode: 308,
  };
  await safeSet(subdomainCacheKey(subdomain), resolved);
  return resolved;
};

const resolveHost = async (input: string): Promise<WebsiteHostResolution> => {
  const host = normalizeHost(input);
  const cached = await safeGet<WebsiteHostResolution>(hostCacheKey(host));
  if (cached?.version === ROUTE_CACHE_VERSION && cached.requestedHost === host) {
    return cached;
  }

  const subdomain = parsePlatformSubdomain(host);
  const route = await resolveSubdomain(subdomain);
  const canonicalHost = `${route.canonicalSubdomain}.${WEBSITE_BASE_DOMAIN}`;
  const resolved: WebsiteHostResolution = {
    ...route,
    requestedHost: host,
    canonicalHost,
  };
  await safeSet(hostCacheKey(host), resolved);
  return resolved;
};

const invalidateSubdomains = async (labels: Array<string | null | undefined>) => {
  const normalized = labels
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  const keys = normalized.flatMap((label) => {
    const result = [subdomainCacheKey(label)];
    if (WEBSITE_BASE_DOMAIN) result.push(hostCacheKey(`${label}.${WEBSITE_BASE_DOMAIN}`));
    return result;
  });
  await safeDelete([...new Set(keys)]);
};

export const WebsiteHostResolverService = {
  resolveSubdomain,
  resolveHost,
  invalidateSubdomains,
};
