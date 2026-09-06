import { recordTraceResponseCache } from "../../lib/monitoring/requestTrace";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  WEBSITE_BASE_DOMAIN,
  WEBSITE_CUSTOM_DOMAINS_ENABLED,
  WEBSITE_ROUTE_CACHE_JITTER_RATIO,
  WEBSITE_ROUTE_CACHE_TTL_SECONDS,
  WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS,
  WEBSITE_ROUTE_REBUILD_LOCK_SECONDS,
  WEBSITE_ROUTE_WAIT_FOR_FILL_MS,
} from "../../config/ENV";
import redis from "../../config/redis";
import { CacheNamespaces } from "../../lib/cache/cachePolicy";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeSubdomain } from "./websiteIdentity";
import { readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { getCanonicalWebsiteHost } from "./websiteCanonicalHost";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";
import { TenantAccessResolver, type TenantAccessResolution } from "../Entitlement/tenantAccessResolver.service";

const ROUTE_CACHE_VERSION = 10 as const;
const CACHE_NAMESPACE = `site-route:v${ROUTE_CACHE_VERSION}`;
const SUBDOMAIN_KEY_PREFIX = `${CACHE_NAMESPACE}:subdomain:`;
const LOCK_KEY_PREFIX = `${CACHE_NAMESPACE}:lock:`;
const GENERATION_KEY_PREFIX = `${CACHE_NAMESPACE}:generation:`;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type WebsiteHostRouteKind = "platform_subdomain" | "subdomain_alias" | "custom_domain";
export type WebsiteHostAvailability = "live" | "unpublished" | "suspended";

export interface WebsiteRouteResolution {
  version: typeof ROUTE_CACHE_VERSION;
  websiteId: string;
  publishedRevisionNumber: number | null;
  organizationId: string;
  accessGeneration: string | null;
  validUntil: string;
  businessName: string;
  requestedSubdomain: string;
  canonicalSubdomain: string;
  isAlias: boolean;
  redirectCode: 308 | null;
  primaryCustomHost: string | null;
  availability: WebsiteHostAvailability;
}

export interface WebsiteHostResolution extends WebsiteRouteResolution {
  requestedHost: string;
  canonicalHost: string;
  routeKind: WebsiteHostRouteKind;
  customDomain: string | null;
}

export type WebsiteHostResolverSource = "redis" | "redis-fill" | "database" | "database-redis-unavailable";

export interface WebsiteHostResolverDiagnostics {
  source: WebsiteHostResolverSource;
  durationMs: number;
}

type NegativeCacheEntry = {
  version: typeof ROUTE_CACHE_VERSION;
  notFound: true;
  key: string;
};

const subdomainCacheKey = (subdomain: string) => `${SUBDOMAIN_KEY_PREFIX}${subdomain}`;
const hostCacheKey = (host: string) => CacheNamespaces.websiteHost(host);
const routeLockKey = (cacheKey: string) => `${LOCK_KEY_PREFIX}${cacheKey}`;
const routeGenerationKey = (cacheKey: string) => `${GENERATION_KEY_PREFIX}${cacheKey}`;

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

const getRouteGeneration = async (cacheKey: string): Promise<number | null> => {
  try {
    const raw = await redis.get(routeGenerationKey(cacheKey));
    if (!raw) return 0;
    const generation = Number(raw);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  } catch {
    return null;
  }
};

const safeSetForGeneration = async (
  cacheKey: string,
  value: unknown,
  generation: number,
  ttlSeconds = WEBSITE_ROUTE_CACHE_TTL_SECONDS,
): Promise<boolean | null> => {
  try {
    let ttlMs = jitteredTtl(ttlSeconds) * 1000;
    const route = value as Partial<WebsiteRouteResolution>;
    if (route.websiteId) {
      if (!route.organizationId || !route.accessGeneration || !route.validUntil ||
          !await TenantAccessResolver.isCurrentGeneration(route.organizationId, route.accessGeneration)) return false;
      ttlMs = Math.min(ttlMs, Math.floor(Date.parse(route.validUntil) - Date.now()));
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    }
    const result = await redis.eval(
      `
        local current = redis.call('GET', KEYS[2])
        if not current then current = '0' end
        if current ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
        return 1
      `,
      2,
      cacheKey,
      routeGenerationKey(cacheKey),
      String(generation),
      JSON.stringify(value),
      String(ttlMs),
    );
    return Number(result) === 1;
  } catch {
    return null;
  }
};

const invalidateCacheKeys = async (keys: string[]) => {
  const unique = [...new Set(keys)];
  let delivered = true;
  for (const key of unique) {
    try {
      const result = await redis.eval(
        `
          redis.call('INCR', KEYS[2])
          redis.call('DEL', KEYS[1], KEYS[3])
          return 1
        `,
        3,
        key,
        routeGenerationKey(key),
        routeLockKey(key),
      );
      delivered = Number(result) === 1 && delivered;
    } catch {
      delivered = false;
    }
  }
  return delivered;
};

const acquireRouteLock = async (cacheKey: string): Promise<{ token: string | null; redisAvailable: boolean }> => {
  const token = randomUUID();
  try {
    const result = await redis.set(
      routeLockKey(cacheKey),
      token,
      "EX",
      WEBSITE_ROUTE_REBUILD_LOCK_SECONDS,
      "NX",
    );
    return { token: result === "OK" ? token : null, redisAvailable: true };
  } catch {
    return { token: null, redisAvailable: false };
  }
};

const releaseRouteLock = async (cacheKey: string, token: string): Promise<void> => {
  try {
    await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      routeLockKey(cacheKey),
      token,
    );
  } catch {
    // lock TTL handles cleanup
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForRouteFill = async <T>(reader: () => Promise<T | null>): Promise<T | null> => {
  const startedAt = Date.now();
  let delay = 15;
  while (Date.now() - startedAt < WEBSITE_ROUTE_WAIT_FOR_FILL_MS) {
    await sleep(delay);
    const value = await reader();
    if (value) return value;
    delay = Math.min(100, Math.round(delay * 1.7));
  }
  return null;
};

const cacheNotFound = async (key: string, identity: string, generation: number): Promise<boolean | null> => {
  const entry: NegativeCacheEntry = {
    version: ROUTE_CACHE_VERSION,
    notFound: true,
    key: identity,
  };
  return safeSetForGeneration(key, entry, generation, WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS);
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


const hasCustomDomainRouting = (entitlements: Awaited<ReturnType<typeof WebsiteEntitlementService.getForAdminId>>) =>
  WEBSITE_CUSTOM_DOMAINS_ENABLED && entitlements.customDomains && entitlements.customDomainLimit > 0;

const websiteAvailability = (access: TenantAccessResolution): WebsiteHostAvailability => {
  if (!access.access.dashboardAllowed) return "suspended";
  if (!access.access.publicWebsiteAllowed) return "unpublished";
  return "live";
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
const validCachedRoute = async (route: WebsiteRouteResolution): Promise<boolean> =>
  Boolean(route.organizationId && route.accessGeneration && Number.isFinite(Date.parse(route.validUntil)) &&
    Date.parse(route.validUntil) > Date.now() &&
    await TenantAccessResolver.isCurrentGeneration(route.organizationId, route.accessGeneration));

const accessMetadata = (access: TenantAccessResolution) => ({
  organizationId: access.organizationId,
  accessGeneration: access.generation,
  validUntil: access.validUntil,
});

const readSubdomainCache = async (key: string, subdomain: string): Promise<WebsiteRouteResolution | null> => {
  const cached = await safeGet<WebsiteRouteResolution | NegativeCacheEntry>(key);
  if (isNegativeCacheHit(cached, subdomain)) {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }
  if (
    cached &&
    cached.version === ROUTE_CACHE_VERSION &&
    "requestedSubdomain" in cached &&
    cached.requestedSubdomain === subdomain &&
    await validCachedRoute(cached as WebsiteRouteResolution)
  ) {
    return cached as WebsiteRouteResolution;
  }
  return null;
};

const loadSubdomainFromDatabase = async (subdomain: string): Promise<WebsiteRouteResolution | null> => {
  const website = await prisma.businessWebsite.findUnique({
    where: { subdomain },
    select: {
      id: true,
      subdomain: true,
      status: true,
      publishedRevisionNumber: true,
      admin: { select: {
        id: true,
        businessName: true,
      } },
      domains: {
        where: { ...readyWebsiteDomainWhere, isPrimary: true },
        select: { domain: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (website) {
    const access = await TenantAccessResolver.resolve(website.admin.id);
    const entitlements = WebsiteEntitlementService.fromAccess(access);
    return {
      version: ROUTE_CACHE_VERSION,
      websiteId: website.id,
      publishedRevisionNumber: website.publishedRevisionNumber ?? null,
      ...accessMetadata(access),
      businessName: website.admin.businessName,
      requestedSubdomain: subdomain,
      canonicalSubdomain: website.subdomain,
      isAlias: false,
      redirectCode: null,
      primaryCustomHost: hasCustomDomainRouting(entitlements)
        ? website.domains[0]?.domain ?? null
        : null,
      availability: websiteAvailability(access),
    };
  }

  const alias = await prisma.websiteSubdomainAlias.findUnique({
    where: { subdomain },
    select: {
      websiteId: true,
      website: {
        select: {
          subdomain: true,
          status: true,
          publishedRevisionNumber: true,
          admin: { select: {
            id: true,
            businessName: true,
          } },
          domains: {
            where: { ...readyWebsiteDomainWhere, isPrimary: true },
            select: { domain: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });
  if (!alias) return null;

  const aliasAccess = await TenantAccessResolver.resolve(alias.website.admin.id);
  const aliasEntitlements = WebsiteEntitlementService.fromAccess(aliasAccess);
  return {
    version: ROUTE_CACHE_VERSION,
    websiteId: alias.websiteId,
    publishedRevisionNumber: alias.website.publishedRevisionNumber ?? null,
    ...accessMetadata(aliasAccess),
    businessName: alias.website.admin.businessName,
    requestedSubdomain: subdomain,
    canonicalSubdomain: alias.website.subdomain,
    isAlias: true,
    redirectCode: 308,
    primaryCustomHost: hasCustomDomainRouting(aliasEntitlements)
      ? alias.website.domains[0]?.domain ?? null
      : null,
    availability: websiteAvailability(aliasAccess),
  };
};

/**
 * Resolve one tenant label to its website. Cache misses are serialized across
 * app instances and writes are generation-guarded, so a rename/suspension that
 * invalidates Redis cannot be overwritten by an older in-flight SQL result.
 */
const resolveSubdomain = async (input: string): Promise<WebsiteRouteResolution> => {
  let subdomain: string;
  try {
    subdomain = normalizeSubdomain(input);
  } catch {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const key = subdomainCacheKey(subdomain);
  const cached = await readSubdomainCache(key, subdomain);
  if (cached) return cached;

  const lock = await acquireRouteLock(key);
  if (!lock.redisAvailable) {
    const direct = await loadSubdomainFromDatabase(subdomain);
    if (!direct) throw new AppError(status.NOT_FOUND, "Website not found");
    return direct;
  }

  if (!lock.token) {
    const filled = await waitForRouteFill(() => readSubdomainCache(key, subdomain));
    if (filled) return filled;
  }

  const token = lock.token;
  try {
    if (token) {
      const filled = await readSubdomainCache(key, subdomain);
      if (filled) return filled;
    }

    const generation = await getRouteGeneration(key);
    const loaded = await loadSubdomainFromDatabase(subdomain);
    if (generation === null) {
      if (!loaded) throw new AppError(status.NOT_FOUND, "Website not found");
      return loaded;
    }

    if (!loaded) {
      const stored = await cacheNotFound(key, subdomain, generation);
      if (stored === false) {
        const latest = await loadSubdomainFromDatabase(subdomain);
        if (latest) return latest;
      }
      throw new AppError(status.NOT_FOUND, "Website not found");
    }

    const stored = await safeSetForGeneration(key, loaded, generation);
    if (stored === false) {
      const latest = await loadSubdomainFromDatabase(subdomain);
      if (!latest) throw new AppError(status.NOT_FOUND, "Website not found");
      return latest;
    }
    return loaded;
  } finally {
    if (token) await releaseRouteLock(key, token);
  }
};

const resolveCustomHost = async (host: string): Promise<WebsiteHostResolution> => {
  if (!WEBSITE_CUSTOM_DOMAINS_ENABLED) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  const domain = await prisma.websiteDomain.findFirst({
    where: { domain: host, ...readyWebsiteDomainWhere },
    select: {
      id: true,
      websiteId: true,
      domain: true,
      status: true,
      isPrimary: true,
      createdAt: true,
      website: {
        select: {
          subdomain: true,
          status: true,
          publishedRevisionNumber: true,
          admin: { select: {
        id: true,
        businessName: true,
      } },
          domains: {
            where: { ...readyWebsiteDomainWhere },
            select: { id: true, domain: true, isPrimary: true, createdAt: true },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });

  if (!domain) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }

  const domainAccess = await TenantAccessResolver.resolve(domain.website.admin.id);
  const entitlements = WebsiteEntitlementService.fromAccess(domainAccess);
  if (!hasCustomDomainRouting(entitlements)) {
    // A downgrade must remove premium routing immediately without deleting the
    // verified domain record. Upgrading later restores it without DNS setup.
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }

  // Domain-count entitlements apply to routing as well as creation. On a
  // downgrade retain all verified records/DNS configuration, but only route
  // the primary domain plus the oldest additional verified aliases up to the
  // plan limit. Making another retained domain primary intentionally moves it
  // into the active allowance without destructive cleanup.
  const allowedDomainIds = new Set(
    domain.website.domains
      .slice(0, entitlements.customDomainLimit)
      .map((item) => item.id),
  );
  if (!allowedDomainIds.has(domain.id)) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }

  const primaryCustomHost = domain.website.domains.find((item) => item.isPrimary)?.domain ?? null;
  const canonicalHost = getCanonicalWebsiteHost(domain.website.subdomain, primaryCustomHost) ?? domain.domain;
  const shouldRedirect = canonicalHost !== host;

  return {
    version: ROUTE_CACHE_VERSION,
    websiteId: domain.websiteId,
    publishedRevisionNumber: domain.website.publishedRevisionNumber ?? null,
    ...accessMetadata(domainAccess),
    businessName: domain.website.admin.businessName,
    requestedSubdomain: domain.website.subdomain,
    canonicalSubdomain: domain.website.subdomain,
    isAlias: shouldRedirect,
    redirectCode: shouldRedirect ? 308 : null,
    primaryCustomHost,
    requestedHost: host,
    canonicalHost,
    routeKind: "custom_domain",
    customDomain: domain.domain,
    availability: websiteAvailability(domainAccess),
  };
};

/**
 * Resolve a full request host for the frontend proxy. This is the single
 * canonical host-routing read path used by free subdomains, old aliases and
 * verified custom domains.
 */
const readHostCache = async (key: string, host: string): Promise<WebsiteHostResolution | null> => {
  const cached = await safeGet<WebsiteHostResolution | NegativeCacheEntry>(key);
  if (isNegativeCacheHit(cached, host)) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  if (
    cached &&
    cached.version === ROUTE_CACHE_VERSION &&
    "requestedHost" in cached &&
    cached.requestedHost === host &&
    await validCachedRoute(cached as WebsiteHostResolution)
  ) {
    return cached as WebsiteHostResolution;
  }
  return null;
};

const loadHostFromDatabase = async (host: string): Promise<WebsiteHostResolution> => {
  const platformSubdomain = platformSubdomainFromHost(host);
  if (platformSubdomain) {
    const route = await resolveSubdomain(platformSubdomain);
    const canonicalHost = getCanonicalWebsiteHost(route.canonicalSubdomain, route.primaryCustomHost);
    if (!canonicalHost) throw new AppError(status.NOT_FOUND, "Website host not found");
    const shouldRedirect = canonicalHost !== host;
    return {
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
  }
  return resolveCustomHost(host);
};

/**
 * Resolve a full request host for the frontend proxy. A distributed Redis lock
 * collapses cold-host stampedes, while per-key generations prevent an older DB
 * result from repopulating a route after suspension/domain/subdomain changes.
 */
const resolveHostWithDiagnostics = async (input: string): Promise<{
  resolution: WebsiteHostResolution;
  diagnostics: WebsiteHostResolverDiagnostics;
}> => {
  const startedAt = performance.now();
  const finish = async (resolution: WebsiteHostResolution, source: WebsiteHostResolverSource) => {
    // SQL/rebuild waits may cross an expiry or an epoch rotation. Re-evaluate
    // once before sending this time-bounded routing decision to the edge.
    if (Date.parse(resolution.validUntil) <= Date.now() ||
        (resolution.accessGeneration !== null && !await validCachedRoute(resolution))) {
      await TenantAccessResolver.resolve(resolution.organizationId, { fresh: true });
      resolution = await loadHostFromDatabase(host);
      source = "database";
      if (Date.parse(resolution.validUntil) <= Date.now() ||
          (resolution.accessGeneration !== null && !await validCachedRoute(resolution))) {
        throw new AppError(status.SERVICE_UNAVAILABLE, "Website authorization changed; retry the request");
      }
    }
    recordTraceResponseCache(source === "redis" || source === "redis-fill" ? "hit" : "miss");
    return { resolution, diagnostics: { source, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 } };
  };

  const host = normalizeHost(input);
  const key = hostCacheKey(host);
  const cached = await readHostCache(key, host);
  if (cached) return finish(cached, "redis");

  const lock = await acquireRouteLock(key);
  if (!lock.redisAvailable) {
    return finish(await loadHostFromDatabase(host), "database-redis-unavailable");
  }

  if (!lock.token) {
    const filled = await waitForRouteFill(() => readHostCache(key, host));
    if (filled) return finish(filled, "redis-fill");
  }

  const token = lock.token;
  try {
    if (token) {
      const filled = await readHostCache(key, host);
      if (filled) return finish(filled, "redis");
    }

    const generation = await getRouteGeneration(key);
    try {
      const loaded = await loadHostFromDatabase(host);
      if (generation === null) return finish(loaded, "database-redis-unavailable");
      const stored = await safeSetForGeneration(key, loaded, generation);
      if (stored === false) return finish(await loadHostFromDatabase(host), "database");
      return finish(loaded, "database");
    } catch (error) {
      if (platformSubdomainFromHost(host) && error instanceof AppError && error.statusCode === status.NOT_FOUND && generation !== null) {
        const stored = await cacheNotFound(key, host, generation);
        if (stored === false) return finish(await loadHostFromDatabase(host), "database");
      }
      throw error;
    }
  } finally {
    if (token) await releaseRouteLock(key, token);
  }
};

const resolveHost = async (input: string): Promise<WebsiteHostResolution> =>
  (await resolveHostWithDiagnostics(input)).resolution;

const invalidateSubdomains = async (labels: Array<string | null | undefined>) => {
  const normalized = labels
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  const keys = normalized.flatMap((label) => {
    const result = [subdomainCacheKey(label)];
    if (WEBSITE_BASE_DOMAIN) result.push(hostCacheKey(`${label}.${WEBSITE_BASE_DOMAIN}`));
    return result;
  });
  return invalidateCacheKeys(keys);
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
  return invalidateCacheKeys(keys);
};

export const WebsiteHostResolverService = {
  resolveSubdomain,
  resolveHost,
  resolveHostWithDiagnostics,
  invalidateSubdomains,
  invalidateHosts,
};
