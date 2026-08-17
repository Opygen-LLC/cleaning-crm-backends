import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import status from "http-status";
import redis from "../../config/redis";
import AppError from "../../errorHelper/AppError";
import {
  WEBSITE_BASE_DOMAIN,
  WEBSITE_CNAME_TARGET,
  WEBSITE_CUSTOM_DOMAINS_ENABLED,
  WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE,
  WEBSITE_DOMAIN_PROVIDER,
  WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS,
} from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { WebsiteDomainCreateInput } from "./website.interface";
import { normalizeDomain } from "./websiteIdentity";
import {
  type WebsiteDomainProviderState,
  WebsiteDomainProviderService,
} from "./websiteDomainProvider.service";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { isWebsiteDomainRoutingReady } from "./websiteDomainReadiness";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

const getOwnedWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true, subdomain: true },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  return website;
};

const getOwnedDomain = async (domainId: string, user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  const domain = await prisma.websiteDomain.findFirst({
    where: { id: domainId, websiteId: website.id },
  });
  if (!domain) throw new AppError(status.NOT_FOUND, "Website domain not found");
  return { website, domain };
};


const invalidateWebsiteRouting = async (websiteId: string, subdomain: string, extraHosts: string[] = []) => {
  const [aliases, domains] = await Promise.all([
    prisma.websiteSubdomainAlias.findMany({
      where: { websiteId },
      select: { subdomain: true },
    }),
    prisma.websiteDomain.findMany({
      where: { websiteId, status: "VERIFIED" as any },
      select: { domain: true },
    }),
  ]);
  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([subdomain, ...aliases.map((item) => item.subdomain)]),
    WebsiteHostResolverService.invalidateHosts([...domains.map((item) => item.domain), ...extraHosts]),
    WebsiteProjectionCacheService.invalidateWebsite(websiteId),
  ]);
};

const ownershipRecord = (domain: string, token: string) => ({
  type: "TXT" as const,
  host: `_cleancrm-verification.${domain}`,
  value: token,
});

const requiredDns = (
  domain: string,
  token: string,
  provider?: WebsiteDomainProviderState | null,
) => {
  const providerVerification = provider?.dnsRecords
    .filter((record) => record.purpose === "provider_verification")
    .map(({ type, host, value }) => ({ type, host, value })) ?? [];
  const routingRecord = provider?.dnsRecords.find((record) => record.purpose === "routing") ?? null;

  return {
    ownership: ownershipRecord(domain, token),
    providerVerification,
    routing: routingRecord
      ? { type: routingRecord.type, host: routingRecord.host, value: routingRecord.value }
      : WEBSITE_DOMAIN_PROVIDER === "vercel" && !provider
        ? null
        : WEBSITE_CNAME_TARGET
          ? { type: "CNAME", host: domain, value: WEBSITE_CNAME_TARGET }
          : null,
  };
};

const hasOwnershipTxt = async (domain: string, token: string): Promise<boolean> => {
  try {
    const records = await dns.resolveTxt(`_cleancrm-verification.${domain}`);
    return records.some((parts) => parts.join("") === token);
  } catch {
    return false;
  }
};

const providerName = () => WEBSITE_DOMAIN_PROVIDER.toUpperCase();
const PENDING_DOMAIN_CLAIM_TTL_MS = 48 * 60 * 60 * 1000;
const VERIFY_LOCK_PREFIX = "website:domain:verify:v1:";

const assertCustomDomainsEnabled = () => {
  if (!WEBSITE_CUSTOM_DOMAINS_ENABLED) {
    throw new AppError(
      status.SERVICE_UNAVAILABLE,
      "Custom domains are not enabled for this deployment yet. The free platform subdomain remains available.",
    );
  }
};

const withDomainVerificationLock = async <T>(domainId: string, work: () => Promise<T>): Promise<T> => {
  const key = `${VERIFY_LOCK_PREFIX}${domainId}`;
  const token = randomBytes(24).toString("hex");
  let acquired = false;
  try {
    try {
      acquired = (await redis.set(key, token, "EX", WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS, "NX")) === "OK";
    } catch {
      // Redis is an availability optimization, not an authorization source. If
      // it is down, continue safely; the database and provider remain the
      // authoritative state.
      acquired = true;
    }

    if (!acquired) {
      throw new AppError(status.CONFLICT, "Domain verification is already in progress. Try again shortly.");
    }
    return await work();
  } finally {
    if (acquired) {
      try {
        await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          1,
          key,
          token,
        );
      } catch {
        // Lock TTL is the final safety net when Redis disappears mid-request.
      }
    }
  }
};

const applyProviderState = async (
  domainId: string,
  domain: string,
  verificationToken: string,
  provider: WebsiteDomainProviderState,
  extra: {
    status?: "PENDING" | "VERIFYING" | "VERIFIED" | "FAILED";
    ownershipVerified?: boolean;
    failureReason?: string | null;
    checkedAt?: Date;
    verifiedAt?: Date | null;
  } = {},
) => prisma.websiteDomain.update({
  where: { id: domainId },
  data: {
    provider: provider.provider,
    providerVerified: provider.verified,
    routingVerified: provider.routingConfigured,
    tlsStatus: provider.tlsStatus,
    providerData: provider.providerData as any,
    lastProviderSyncAt: new Date(),
    requiredDns: requiredDns(domain, verificationToken, provider) as any,
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.ownershipVerified !== undefined ? { ownershipVerified: extra.ownershipVerified } : {}),
    ...(extra.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
    ...(extra.checkedAt ? { lastCheckedAt: extra.checkedAt } : {}),
    ...(extra.verifiedAt !== undefined ? { verifiedAt: extra.verifiedAt } : {}),
  },
});

const addDomain = async (payload: WebsiteDomainCreateInput, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  WebsiteDomainProviderService.assertConfigured();
  const website = await getOwnedWebsite(user);
  const domain = normalizeDomain(payload.domain);
  if (WEBSITE_BASE_DOMAIN && (domain === WEBSITE_BASE_DOMAIN || domain.endsWith(`.${WEBSITE_BASE_DOMAIN}`))) {
    throw new AppError(status.BAD_REQUEST, "Platform subdomains cannot be added as custom domains");
  }

  const verificationToken = randomBytes(32).toString("hex");
  const staleBefore = new Date(Date.now() - PENDING_DOMAIN_CLAIM_TTL_MS);
  return prisma.$transaction(async (tx: any) => {
    // One website-level lock makes the per-tenant domain cap race-safe when two
    // different hostnames are connected concurrently. The hostname lock then
    // serializes cross-tenant claims for the same domain.
    await acquireTextTransactionAdvisoryLock(tx, `website-domain-list:${website.id}`);
    await acquireTextTransactionAdvisoryLock(tx, `website-domain:${domain}`);

    const existing = await tx.websiteDomain.findUnique({
      where: { domain },
      select: {
        id: true, websiteId: true, status: true, createdAt: true,
        ownershipVerified: true, providerVerified: true,
      },
    });
    if (existing) {
      if (existing.websiteId === website.id) {
        throw new AppError(status.CONFLICT, "This domain is already connected to your website");
      }
      const canReleaseStaleClaim =
        existing.status !== "VERIFIED" &&
        !existing.ownershipVerified &&
        !existing.providerVerified &&
        existing.createdAt < staleBefore;
      if (!canReleaseStaleClaim) {
        throw new AppError(status.CONFLICT, "This domain is already connected to another website");
      }
      await tx.websiteDomain.delete({ where: { id: existing.id } });
    }

    const domainCount = await tx.websiteDomain.count({ where: { websiteId: website.id } });
    if (domainCount >= WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE) {
      throw new AppError(
        status.CONFLICT,
        `This website already has the maximum of ${WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE} custom domains`,
      );
    }

    // Do not attach the hostname to the hosting provider yet. The customer
    // must first prove control with our TXT challenge. Provider attachment,
    // provider verification and TLS provisioning begin in verifyDomain().
    return tx.websiteDomain.create({
      data: {
        websiteId: website.id,
        domain,
        verificationToken,
        provider: providerName(),
        status: "PENDING",
        requiredDns: requiredDns(domain, verificationToken) as any,
        failureReason: "Add the ownership TXT record, wait for DNS propagation, then check again",
      },
    });
  });
};

const listDomains = async (user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  return prisma.websiteDomain.findMany({
    where: { websiteId: website.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
};

const verifyDomain = async (domainId: string, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  WebsiteDomainProviderService.assertConfigured();
  const owned = await getOwnedDomain(domainId, user);

  return withDomainVerificationLock(domainId, async () => {
    // Re-read after the distributed lock. Another API replica may have
    // completed verification between the initial ownership lookup and lock
    // acquisition.
    const domain = await prisma.websiteDomain.findFirst({
      where: { id: domainId, websiteId: owned.website.id },
    });
    if (!domain) throw new AppError(status.NOT_FOUND, "Website domain not found");

    const checkedAt = new Date();
    const staleVerifyingBefore = new Date(checkedAt.getTime() - WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS * 1000);
    const claimed = await prisma.websiteDomain.updateMany({
      where: {
        id: domain.id,
        websiteId: owned.website.id,
        OR: [
          { status: { not: "VERIFYING" } },
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: staleVerifyingBefore } },
        ],
      },
      data: { status: "VERIFYING", failureReason: null, lastCheckedAt: checkedAt },
    });
    if (claimed.count !== 1) {
      throw new AppError(status.CONFLICT, "Domain verification is already in progress. Try again shortly.");
    }

    const ownershipVerified = await hasOwnershipTxt(domain.domain, domain.verificationToken);
    if (!ownershipVerified) {
      const updated = await prisma.websiteDomain.update({
        where: { id: domain.id },
        data: {
          status: "PENDING",
          ownershipVerified: false,
          providerVerified: false,
          routingVerified: false,
          tlsStatus: "PENDING",
          verifiedAt: null,
          failureReason: "Add the ownership TXT record, wait for DNS propagation, then check again",
          lastCheckedAt: checkedAt,
        },
      });
      await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
      return updated;
    }

    let provider: WebsiteDomainProviderState;
    try {
      // Provider attachment is intentionally delayed until our independent TXT
      // challenge proves that this tenant controls the hostname.
      provider = await WebsiteDomainProviderService.verify(domain.domain);
    } catch (error) {
      const failureReason = WebsiteDomainProviderService.describeProviderError(error);
      await prisma.websiteDomain.update({
        where: { id: domain.id },
        data: {
          status: "FAILED",
          ownershipVerified: true,
          providerVerified: false,
          routingVerified: false,
          failureReason,
          tlsStatus: "ERROR",
          verifiedAt: null,
          lastProviderSyncAt: new Date(),
          lastCheckedAt: checkedAt,
        },
      });
      await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
      throw new AppError(status.BAD_GATEWAY, failureReason);
    }

    const providerReady = provider.verified && provider.routingConfigured;
    const tlsReady = provider.tlsStatus === "READY" || provider.tlsStatus === "EXTERNAL";
    const verified = providerReady && tlsReady;
    const failureReason = verified
      ? null
      : !provider.verified
        ? "The hosting provider is still waiting for its domain verification challenge"
        : !provider.routingConfigured
          ? "DNS routing is not pointing to the website hosting provider yet"
          : "TLS provisioning is still in progress";

    const updated = await applyProviderState(domain.id, domain.domain, domain.verificationToken, provider, {
      status: verified ? "VERIFIED" : "PENDING",
      ownershipVerified: true,
      failureReason,
      checkedAt,
      verifiedAt: verified ? new Date() : null,
    });

    await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
    return updated;
  });
};

const removeDomain = async (domainId: string, user: IRequestUser) => {
  const { website, domain } = await getOwnedDomain(domainId, user);

  // Detach from the hosting project first. If that fails, keep the database row
  // so the owner can retry instead of leaving a live provider alias that the
  // application no longer knows how to manage.
  try {
    await WebsiteDomainProviderService.detach(domain.domain);
  } catch (error) {
    throw new AppError(status.BAD_GATEWAY, WebsiteDomainProviderService.describeProviderError(error));
  }

  await prisma.websiteDomain.delete({ where: { id: domainId } });
  await invalidateWebsiteRouting(website.id, website.subdomain, [domain.domain]);
  return { id: domainId, deleted: true } as const;
};

const setPrimaryDomain = async (domainId: string, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  const { website } = await getOwnedDomain(domainId, user);

  const updated = await prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, website.id);

    // Re-read inside the website lock. A verification worker/request may have
    // changed the domain state after the initial tenant-scoped lookup. Never
    // promote a stale or foreign domain to canonical routing.
    const candidate = await tx.websiteDomain.findFirst({
      where: { id: domainId, websiteId: website.id },
      select: {
        id: true, status: true, ownershipVerified: true, providerVerified: true,
        routingVerified: true, tlsStatus: true,
      },
    });
    if (!candidate) throw new AppError(status.NOT_FOUND, "Website domain not found");
    if (!isWebsiteDomainRoutingReady(candidate)) {
      throw new AppError(status.CONFLICT, "Complete ownership, DNS, provider, and TLS verification before making this domain primary");
    }

    await tx.websiteDomain.updateMany({
      where: { websiteId: website.id, isPrimary: true, id: { not: domainId } },
      data: { isPrimary: false },
    });
    return tx.websiteDomain.update({ where: { id: domainId }, data: { isPrimary: true } });
  });

  await invalidateWebsiteRouting(website.id, website.subdomain);
  return updated;
};

/** Internal hook retained for compatibility with future async/domain workers. */
const updateVerificationState = async (
  domainId: string,
  state: { status: "PENDING" | "VERIFYING" | "VERIFIED" | "FAILED"; failureReason?: string | null; checkedAt?: Date },
) => {
  const current = await prisma.websiteDomain.findUnique({
    where: { id: domainId },
    select: { domain: true, websiteId: true, website: { select: { subdomain: true } } },
  });
  if (!current) throw new AppError(status.NOT_FOUND, "Website domain not found");
  const updated = await prisma.websiteDomain.update({
    where: { id: domainId },
    data: {
      status: state.status,
      isPrimary: state.status === "VERIFIED" ? undefined : false,
      failureReason: state.failureReason ?? null,
      lastCheckedAt: state.checkedAt ?? new Date(),
      verifiedAt: state.status === "VERIFIED" ? new Date() : null,
    },
  });
  await invalidateWebsiteRouting(current.websiteId, current.website.subdomain, [current.domain]);
  return updated;
};

export const DomainService = {
  addDomain,
  listDomains,
  verifyDomain,
  removeDomain,
  setPrimaryDomain,
  updateVerificationState,
};
