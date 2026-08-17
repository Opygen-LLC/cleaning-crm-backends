import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  WEBSITE_BASE_DOMAIN,
  WEBSITE_ROUTE_CACHE_JITTER_RATIO,
  WEBSITE_ROUTE_CACHE_TTL_SECONDS,
  WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeSubdomain } from "./websiteIdentity";

const ROUTE_CACHE_VERSION = 4 as const;
const CACHE_NAMESPACE = `site-route:v${ROUTE_CACHE_VERSION}`;
const SUBDOMAIN_KEY_PREFIX = `${CACHE_NAMESPACE}:subdomain:`;
const HOST_KEY_PREFIX = `${CACHE_NAMESPACE}:host:`;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type WebsiteHostRouteKind = "platform_subdomain" | "subdomain_alias" | "custom_domain";

export interface WebsiteRouteResolution {
  version: typeof ROUTE_CACHE_VERSION;
  websiteId: string;
  requestedSubdomain: string;
  canonicalSubdomain: string;
  isAlias: boolean;
  redirectCode: 308 | null;
  primaryCustomHost: string | null;
}

export interface WebsiteHostResolution extends WebsiteRouteResolution {
  requestedHost: string;
  canonicalHost: string;
  routeKind: WebsiteHostRouteKind;
  customDomain: string | null;
}

type NegativeCacheEntry = {
  version: typeof ROUTE_CACHE_VERSION;
  notFound: true;
  key: string;
};

const subdomainCacheKey = (subdomain: string) => `${SUBDOMAIN_KEY_PREFIX}${subdomain}`;
const hostCacheKey = (host: string) => `${HOST_KEY_PREFIX}${host}`;

const jitteredTtl = (base: number) => {
  if (!WEBSITE_ROUTE_CACHE_JITTER_RATIO) return base;
  const spread = Math.floor(base * WEBSITE_ROUTE_CACHE_JITTER_RATIO);
  const offset = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(1, base + offset);
};

const safeGet = async <T>(key: string): Promise<T | null> => {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const safeSet = async (key: string, value: unknown, ttlSeconds = WEBSITE_ROUTE_CACHE_TTL_SECONDS) => {
  try {
    await redis.set(key, JSON.stringify(value), "EX", jitteredTtl(ttlSeconds));
  } catch {
    // Redis is a cache only. Database resolution remains authoritative.
  }
};

const safeDelete = async (keys: string[]) => {
  if (!keys.length) return;
  try {
    await redis.del(...keys);
  } catch {
    // Cache invalidation failures must never make a successful mutation fail.
  }
};

const cacheNotFound = async (key: string, identity: string) => {
  const entry: NegativeCacheEntry = {
    version: ROUTE_CACHE_VERSION,
    notFound: true,
    key: identity,
  };
  await safeSet(key, entry, WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS);
};

const isNegativeCacheHit = (value: unknown, identity: string): value is NegativeCacheEntry => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NegativeCacheEntry>;
  return candidate.version === ROUTE_CACHE_VERSION && candidate.notFound === true && candidate.key === identity;
};

/**
 * Normalize a request hostname without trusting arbitrary URL-like input.
 * The public resolver accepts a hostname only; protocol, path, credentials,
 * ports, localhost and IP literals are rejected. Unicode domains are converted
 * to their IDNA ASCII form so cache/database keys are deterministic.
 */
const normalizeHost = (value: string): string => {
  const raw = value.trim().replace(/\.$/, "");
  if (!raw || raw.length > 253 || raw.includes("://") || raw.includes("/") || raw.includes("@") || /\s/.test(raw)) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }

  // Support host:port only for controlled local/integration callers. IPv6 is
  // intentionally rejected because public websites must be DNS hostnames.
  const withoutPort = /^.+:\d+$/.test(raw) ? raw.replace(/:\d+$/, "") : raw;
  const ascii = domainToASCII(withoutPort).toLowerCase();
  if (!ascii || ascii === "localhost" || isIP(ascii)) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  return ascii;
};

const platformSubdomainFromHost = (host: string): string | null => {
  if (!WEBSITE_BASE_DOMAIN) return null;
  if (host === WEBSITE_BASE_DOMAIN) return null;
  const suffix = `.${WEBSITE_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  try {
    return normalizeSubdomain(label);
  } catch {
    return null;
  }
};

/**
 * Resolve one tenant label to its website. Aliases point directly to the
 * current BusinessWebsite row, so repeated renames never build database-level
 * redirect chains. Both hits and short-lived misses are cached in Redis.
 */
const resolveSubdomain = async (input: string): Promise<WebsiteRouteResolution> => {
  let subdomain: string;
  try {
    subdomain = normalizeSubdomain(input);
  } catch {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const key = subdomainCacheKey(subdomain);
  const cached = await safeGet<WebsiteRouteResolution | NegativeCacheEntry>(key);
  if (isNegativeCacheHit(cached, subdomain)) {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }
  if (
    cached &&
    !isNegativeCacheHit(cached, subdomain) &&
    cached.version === ROUTE_CACHE_VERSION &&
    "requestedSubdomain" in cached &&
    cached.requestedSubdomain === subdomain
  ) {
    return cached as WebsiteRouteResolution;
  }

  const website = await prisma.businessWebsite.findUnique({
    where: { subdomain },
    select: {
      id: true,
      subdomain: true,
      domains: {
        where: { status: "VERIFIED" as any, isPrimary: true },
        select: { domain: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (website) {
    const resolved: WebsiteRouteResolution = {
      version: ROUTE_CACHE_VERSION,
      websiteId: website.id,
      requestedSubdomain: subdomain,
      canonicalSubdomain: website.subdomain,
      isAlias: false,
      redirectCode: null,
      primaryCustomHost: website.domains[0]?.domain ?? null,
    };
    await safeSet(key, resolved);
    return resolved;
  }

  const alias = await prisma.websiteSubdomainAlias.findUnique({
    where: { subdomain },
    select: {
      websiteId: true,
      redirectCode: true,
      website: {
        select: {
          subdomain: true,
          domains: {
            where: { status: "VERIFIED" as any, isPrimary: true },
            select: { domain: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });
  if (!alias) {
    await cacheNotFound(key, subdomain);
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const resolved: WebsiteRouteResolution = {
    version: ROUTE_CACHE_VERSION,
    websiteId: alias.websiteId,
    requestedSubdomain: subdomain,
    canonicalSubdomain: alias.website.subdomain,
    isAlias: true,
    // Phase 6 guarantees permanent redirects for historical free subdomains.
    // Fail closed to 308 even if an older row was manually created with a
    // different code.
    redirectCode: 308,
    primaryCustomHost: alias.website.domains[0]?.domain ?? null,
  };
  await safeSet(key, resolved);
  return resolved;
};

const resolveCustomHost = async (host: string): Promise<WebsiteHostResolution> => {
  const domain = await prisma.websiteDomain.findUnique({
    where: { domain: host },
    select: {
      websiteId: true,
      domain: true,
      status: true,
      website: {
        select: {
          subdomain: true,
          domains: {
            where: { status: "VERIFIED" as any, isPrimary: true },
            select: { domain: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });

  if (!domain || domain.status !== "VERIFIED") {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }

  const primaryCustomHost = domain.website.domains[0]?.domain ?? null;
  const platformHost = WEBSITE_BASE_DOMAIN
    ? `${domain.website.subdomain}.${WEBSITE_BASE_DOMAIN}`
    : null;
  const canonicalHost = primaryCustomHost ?? platformHost ?? domain.domain;
  const shouldRedirect = canonicalHost !== host;

  return {
    version: ROUTE_CACHE_VERSION,
    websiteId: domain.websiteId,
    requestedSubdomain: domain.website.subdomain,
    canonicalSubdomain: domain.website.subdomain,
    isAlias: shouldRedirect,
    redirectCode: shouldRedirect ? 308 : null,
    primaryCustomHost,
    requestedHost: host,
    canonicalHost,
    routeKind: "custom_domain",
    customDomain: domain.domain,
  };
};

/**
 * Resolve a full request host for the frontend proxy. This is the single
 * canonical host-routing read path used by free subdomains, old aliases and
 * verified custom domains.
 */
const resolveHost = async (input: string): Promise<WebsiteHostResolution> => {
  const host = normalizeHost(input);
  const key = hostCacheKey(host);
  const cached = await safeGet<WebsiteHostResolution | NegativeCacheEntry>(key);
  if (isNegativeCacheHit(cached, host)) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  if (
    cached &&
    !isNegativeCacheHit(cached, host) &&
    cached.version === ROUTE_CACHE_VERSION &&
    "requestedHost" in cached &&
    cached.requestedHost === host
  ) {
    return cached as WebsiteHostResolution;
  }

  try {
    const platformSubdomain = platformSubdomainFromHost(host);
    let resolved: WebsiteHostResolution;
    if (platformSubdomain) {
      const route = await resolveSubdomain(platformSubdomain);
      const canonicalHost = route.primaryCustomHost
        ?? `${route.canonicalSubdomain}.${WEBSITE_BASE_DOMAIN}`;
      const shouldRedirect = canonicalHost !== host;
      resolved = {
        ...route,
        isAlias: shouldRedirect,
        redirectCode: shouldRedirect ? 308 : null,
        requestedHost: host,
        canonicalHost,
        routeKind: route.requestedSubdomain !== route.canonicalSubdomain
          ? "subdomain_alias"
          : "platform_subdomain",
        customDomain: route.primaryCustomHost,
      };
    } else {
      resolved = await resolveCustomHost(host);
    }

    await safeSet(key, resolved);
    return resolved;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === status.NOT_FOUND) {
      await cacheNotFound(key, host);
    }
    throw error;
  }
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

const invalidateHosts = async (hosts: Array<string | null | undefined>) => {
  const keys: string[] = [];
  for (const value of hosts) {
    if (!value) continue;
    try {
      keys.push(hostCacheKey(normalizeHost(value)));
    } catch {
      // Ignore malformed historical values during invalidation. They cannot be
      // resolved through normalizeHost anyway.
    }
  }
  await safeDelete([...new Set(keys)]);
};

export const WebsiteHostResolverService = {
  resolveSubdomain,
  resolveHost,
  invalidateSubdomains,
  invalidateHosts,
};
