import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeSubdomain } from "./websiteIdentity";

const ROUTE_CACHE_VERSION = 3 as const;
const ROUTE_CACHE_TTL_SECONDS = 300;
const SUBDOMAIN_KEY_PREFIX = "site-subdomain:";
const HOST_KEY_PREFIX = "site-host:";

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
    // Cache invalidation failures must never make a successful mutation fail.
  }
};

const normalizeHost = (value: string): string => {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes("@") || host.includes(" ")) {
    throw new AppError(status.NOT_FOUND, "Website host not found");
  }
  return host.replace(/:\d+$/, "");
};

const platformSubdomainFromHost = (host: string): string | null => {
  if (!WEBSITE_BASE_DOMAIN) return null;
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
 * Resolve one tenant label to its website. Aliases always point directly to the
 * current website row, so renaming repeatedly never creates redirect chains.
 * Misses are intentionally not cached so newly provisioned tenants become live
 * immediately.
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
    select: {
      id: true,
      subdomain: true,
      domains: {
        where: { status: "VERIFIED" as any, isPrimary: true },
        select: { domain: true },
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
    await safeSet(subdomainCacheKey(subdomain), resolved);
    return resolved;
  }

  const alias = await prisma.websiteSubdomainAlias.findUnique({
    where: { subdomain },
    select: {
      websiteId: true,
      website: {
        select: {
          subdomain: true,
          domains: {
            where: { status: "VERIFIED" as any, isPrimary: true },
            select: { domain: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!alias) throw new AppError(status.NOT_FOUND, "Website not found");

  const resolved: WebsiteRouteResolution = {
    version: ROUTE_CACHE_VERSION,
    websiteId: alias.websiteId,
    requestedSubdomain: subdomain,
    canonicalSubdomain: alias.website.subdomain,
    isAlias: true,
    redirectCode: 308,
    primaryCustomHost: alias.website.domains[0]?.domain ?? null,
  };
  await safeSet(subdomainCacheKey(subdomain), resolved);
  return resolved;
};

const resolveCustomHost = async (host: string): Promise<WebsiteHostResolution> => {
  const domain = await prisma.websiteDomain.findUnique({
    where: { domain: host },
    select: {
      websiteId: true,
      domain: true,
      status: true,
      isPrimary: true,
      website: {
        select: {
          subdomain: true,
          domains: {
            where: { status: "VERIFIED" as any, isPrimary: true },
            select: { domain: true },
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

const resolveHost = async (input: string): Promise<WebsiteHostResolution> => {
  const host = normalizeHost(input);
  const cached = await safeGet<WebsiteHostResolution>(hostCacheKey(host));
  if (cached?.version === ROUTE_CACHE_VERSION && cached.requestedHost === host) {
    return cached;
  }

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

const invalidateHosts = async (hosts: Array<string | null | undefined>) => {
  const keys = hosts
    .filter((value): value is string => Boolean(value))
    .map((value) => hostCacheKey(normalizeHost(value)));
  await safeDelete([...new Set(keys)]);
};

export const WebsiteHostResolverService = {
  resolveSubdomain,
  resolveHost,
  invalidateSubdomains,
  invalidateHosts,
};
