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
import { isWebsiteDomainRoutingReady, readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { presentWebsiteDomain } from "./websiteDomainLifecycle";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";

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
      where: { websiteId, ...readyWebsiteDomainWhere } as any,
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
  } catch (error: any) {
    // These resolver results conclusively mean the ownership challenge is not
    // published. Timeouts/SERVFAIL are different: they are transient DNS
    // failures and must never take an already ACTIVE customer domain offline.
    if (["ENODATA", "ENOTFOUND", "NXDOMAIN"].includes(String(error?.code ?? ""))) return false;
    throw error;
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
    isPrimary?: boolean;
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
    ...(extra.isPrimary !== undefined ? { isPrimary: extra.isPrimary } : {}),
    verificationStartedAt: null,
  },
});


/**
 * Keep exactly one routable custom-domain canonical host. The first ACTIVE
 * domain is promoted automatically; subsequent ACTIVE domains stay as aliases
 * until the owner explicitly chooses one. If a primary domain loses any
 * ownership/DNS/TLS gate, it is demoted immediately so the free subdomain (or
 * another healthy primary) becomes canonical instead of sending traffic to a
 * broken hostname.
 */
const ensurePrimaryDomainInvariant = async (websiteId: string, candidateDomainId?: string) =>
  prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, `website-domain-primary:${websiteId}`);

    const currentPrimary = await tx.websiteDomain.findFirst({
      where: { websiteId, isPrimary: true, ...readyWebsiteDomainWhere } as any,
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    if (currentPrimary) {
      // Clean up any stale/multiple primary flags while retaining the healthy
      // canonical domain. A unique partial index is not portable in Prisma, so
      // the transaction lock is the invariant boundary.
      await tx.websiteDomain.updateMany({
        where: { websiteId, isPrimary: true, id: { not: currentPrimary.id } },
        data: { isPrimary: false },
      });
      return candidateDomainId
        ? tx.websiteDomain.findUnique({ where: { id: candidateDomainId } })
        : tx.websiteDomain.findUnique({ where: { id: currentPrimary.id } });
    }

    const candidate = candidateDomainId
      ? await tx.websiteDomain.findFirst({
          where: { id: candidateDomainId, websiteId, ...readyWebsiteDomainWhere } as any,
        })
      : await tx.websiteDomain.findFirst({
          where: { websiteId, ...readyWebsiteDomainWhere } as any,
          orderBy: { createdAt: "asc" },
        });

    await tx.websiteDomain.updateMany({
      where: { websiteId, isPrimary: true },
      data: { isPrimary: false },
    });

    if (!candidate) return null;
    return tx.websiteDomain.update({
      where: { id: candidate.id },
      data: { isPrimary: true },
    });
  });

const present = (domain: any) => presentWebsiteDomain(domain as any);

const addDomain = async (payload: WebsiteDomainCreateInput, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  WebsiteDomainProviderService.assertConfigured();
  const [website, entitlements] = await Promise.all([getOwnedWebsite(user), WebsiteEntitlementService.getForUser(user)]);
  WebsiteEntitlementService.assertCustomDomainsAllowed(entitlements);
  const domain = normalizeDomain(payload.domain);
  if (WEBSITE_BASE_DOMAIN && (domain === WEBSITE_BASE_DOMAIN || domain.endsWith(`.${WEBSITE_BASE_DOMAIN}`))) {
    throw new AppError(status.BAD_REQUEST, "Platform subdomains cannot be added as custom domains");
  }

  const verificationToken = randomBytes(32).toString("hex");
  const staleBefore = new Date(Date.now() - PENDING_DOMAIN_CLAIM_TTL_MS);
  const created = await prisma.$transaction(async (tx: any) => {
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
    const allowedDomainCount = Math.min(WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE, entitlements.customDomainLimit);
    if (domainCount >= allowedDomainCount) {
      throw new AppError(
        status.CONFLICT,
        `Your current plan allows ${allowedDomainCount} custom domain${allowedDomainCount === 1 ? "" : "s"} for this website`,
        { code: "WEBSITE_CUSTOM_DOMAIN_LIMIT", retryable: false },
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
  return present(created);
};

const listDomains = async (user: IRequestUser) => {
  const [website, entitlements] = await Promise.all([
    getOwnedWebsite(user),
    WebsiteEntitlementService.getForUser(user),
  ]);
  const domains = await prisma.websiteDomain.findMany({
    where: { websiteId: website.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  const allowedReadyDomainIds = new Set(
    entitlements.customDomains && entitlements.customDomainLimit > 0
      ? domains
          .filter((domain) => isWebsiteDomainRoutingReady(domain))
          .slice(0, entitlements.customDomainLimit)
          .map((domain) => domain.id)
      : [],
  );

  return domains.map((domain) => ({
    ...present(domain),
    // Keep downgraded records/DNS configuration, but tell the dashboard which
    // verified hostnames are currently inside the plan's routing allowance.
    entitlementActive:
      isWebsiteDomainRoutingReady(domain) && allowedReadyDomainIds.has(domain.id),
  }));
};

const verifyDomain = async (domainId: string, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  WebsiteDomainProviderService.assertConfigured();
  const [owned, entitlements] = await Promise.all([getOwnedDomain(domainId, user), WebsiteEntitlementService.getForUser(user)]);
  WebsiteEntitlementService.assertCustomDomainsAllowed(entitlements);

  return withDomainVerificationLock(domainId, async () => {
    // Re-read after the distributed lock. Another API replica may have
    // completed verification between the initial ownership lookup and lock
    // acquisition.
    const domain = await prisma.websiteDomain.findFirst({
      where: { id: domainId, websiteId: owned.website.id },
    });
    if (!domain) throw new AppError(status.NOT_FOUND, "Website domain not found");

    const checkedAt = new Date();
    const wasRoutingReady = isWebsiteDomainRoutingReady(domain);
    const staleVerificationBefore = new Date(checkedAt.getTime() - WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS * 1000);

    // A database lease is the authoritative cross-replica verification lock.
    // For an already ACTIVE domain we deliberately keep status=VERIFIED while
    // external DNS/provider/TLS checks run so a cache miss cannot make a
    // healthy customer's hostname disappear temporarily.
    const claimed = await prisma.websiteDomain.updateMany({
      where: {
        id: domain.id,
        websiteId: owned.website.id,
        OR: [
          { verificationStartedAt: null },
          { verificationStartedAt: { lt: staleVerificationBefore } },
        ],
      },
      data: {
        verificationStartedAt: checkedAt,
        lastCheckedAt: checkedAt,
        failureReason: null,
        ...(wasRoutingReady ? {} : { status: "VERIFYING" }),
      },
    });
    if (claimed.count !== 1) {
      throw new AppError(status.CONFLICT, "Domain verification is already in progress. Try again shortly.");
    }

    let ownershipVerified: boolean;
    try {
      ownershipVerified = await hasOwnershipTxt(domain.domain, domain.verificationToken);
    } catch {
      const message = "DNS verification lookup temporarily failed. Existing verified routing was kept unchanged. Try again.";
      const updated = await prisma.websiteDomain.update({
        where: { id: domain.id },
        data: {
          status: wasRoutingReady ? "VERIFIED" : "PENDING",
          verificationStartedAt: null,
          failureReason: message,
          lastCheckedAt: checkedAt,
          ...(wasRoutingReady ? {} : { verifiedAt: null }),
        },
      });
      return present(updated);
    }

    if (!ownershipVerified) {
      const updated = await prisma.websiteDomain.update({
        where: { id: domain.id },
        data: {
          status: "PENDING",
          verificationStartedAt: null,
          ownershipVerified: false,
          providerVerified: false,
          routingVerified: false,
          tlsStatus: "PENDING",
          isPrimary: false,
          verifiedAt: null,
          failureReason: "Add the ownership TXT record, wait for DNS propagation, then check again",
          lastCheckedAt: checkedAt,
        },
      });
      await ensurePrimaryDomainInvariant(owned.website.id);
      await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
      return present(updated);
    }

    let provider: WebsiteDomainProviderState;
    try {
      // Provider attachment is intentionally delayed until our independent TXT
      // challenge proves that this tenant controls the hostname.
      provider = await WebsiteDomainProviderService.verify(domain.domain);
    } catch (error) {
      const providerFailure = WebsiteDomainProviderService.describeProviderError(error);
      if (wasRoutingReady) {
        const warning = `Status check could not complete: ${providerFailure}. Existing verified routing remains active until a later successful check proves otherwise.`;
        const preserved = await prisma.websiteDomain.update({
          where: { id: domain.id },
          data: {
            status: "VERIFIED",
            verificationStartedAt: null,
            failureReason: warning,
            lastCheckedAt: checkedAt,
            lastProviderSyncAt: new Date(),
          },
        });
        return present(preserved);
      }

      const failed = await prisma.websiteDomain.update({
        where: { id: domain.id },
        data: {
          status: "FAILED",
          verificationStartedAt: null,
          ownershipVerified: true,
          providerVerified: false,
          routingVerified: false,
          failureReason: providerFailure,
          tlsStatus: "ERROR",
          isPrimary: false,
          verifiedAt: null,
          lastProviderSyncAt: new Date(),
          lastCheckedAt: checkedAt,
        },
      });
      await ensurePrimaryDomainInvariant(owned.website.id);
      await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
      return present(failed);
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
      isPrimary: verified ? undefined : false,
    });

    let canonicalized = updated;
    if (verified) {
      canonicalized = (await ensurePrimaryDomainInvariant(owned.website.id, domain.id)) ?? updated;
    } else {
      await ensurePrimaryDomainInvariant(owned.website.id);
    }
    await invalidateWebsiteRouting(owned.website.id, owned.website.subdomain, [domain.domain]);
    return present(canonicalized);
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
  const promoted = domain.isPrimary ? await ensurePrimaryDomainInvariant(website.id) : null;
  await invalidateWebsiteRouting(website.id, website.subdomain, [domain.domain]);
  return {
    id: domainId,
    deleted: true,
    promotedPrimaryDomain: promoted?.domain ?? null,
  } as const;
};

const setPrimaryDomain = async (domainId: string, user: IRequestUser) => {
  assertCustomDomainsEnabled();
  const [owned, entitlements] = await Promise.all([getOwnedDomain(domainId, user), WebsiteEntitlementService.getForUser(user)]);
  WebsiteEntitlementService.assertCustomDomainsAllowed(entitlements);
  const { website } = owned;

  const updated = await prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, `website-domain-primary:${website.id}`);

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
  return present(updated);
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
      verificationStartedAt: null,
    },
  });
  await ensurePrimaryDomainInvariant(
    current.websiteId,
    state.status === "VERIFIED" ? domainId : undefined,
  );
  await invalidateWebsiteRouting(current.websiteId, current.website.subdomain, [current.domain]);
  return present(updated);
};

export const DomainService = {
  addDomain,
  listDomains,
  verifyDomain,
  removeDomain,
  setPrimaryDomain,
  updateVerificationState,
};
