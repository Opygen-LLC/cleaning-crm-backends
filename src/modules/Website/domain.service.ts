import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  WEBSITE_BASE_DOMAIN,
  WEBSITE_CNAME_TARGET,
  WEBSITE_DOMAIN_PROVIDER,
} from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { WebsiteDomainCreateInput } from "./website.interface";
import { normalizeDomain } from "./websiteIdentity";
import {
  type WebsiteDomainProviderState,
  WebsiteDomainProviderService,
} from "./websiteDomainProvider.service";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";

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
  const website = await getOwnedWebsite(user);
  const domain = normalizeDomain(payload.domain);
  if (WEBSITE_BASE_DOMAIN && (domain === WEBSITE_BASE_DOMAIN || domain.endsWith(`.${WEBSITE_BASE_DOMAIN}`))) {
    throw new AppError(status.BAD_REQUEST, "Platform subdomains cannot be added as custom domains");
  }

  const verificationToken = randomBytes(32).toString("hex");
  const staleBefore = new Date(Date.now() - PENDING_DOMAIN_CLAIM_TTL_MS);
  return prisma.$transaction(async (tx: any) => {
    // Serialize claims for the hostname. Unverified claims expire so another
    // tenant cannot indefinitely squat a customer-owned domain in our DB.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`website-domain:${domain}`}))`;
    const existing = await tx.websiteDomain.findUnique({
      where: { domain },
      select: { id: true, websiteId: true, status: true, createdAt: true },
    });
    if (existing) {
      if (existing.websiteId === website.id) {
        throw new AppError(status.CONFLICT, "This domain is already connected to your website");
      }
      const canReleaseStaleClaim = existing.status !== "VERIFIED" && existing.createdAt < staleBefore;
      if (!canReleaseStaleClaim) {
        throw new AppError(status.CONFLICT, "This domain is already connected to another website");
      }
      await tx.websiteDomain.delete({ where: { id: existing.id } });
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
  const { website, domain } = await getOwnedDomain(domainId, user);
  const checkedAt = new Date();
  await prisma.websiteDomain.update({
    where: { id: domain.id },
    data: { status: "VERIFYING", failureReason: null, lastCheckedAt: checkedAt },
  });

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
        failureReason: "Add the ownership TXT record, wait for DNS propagation, then check again",
        lastCheckedAt: checkedAt,
      },
    });
    await invalidateWebsiteRouting(website.id, website.subdomain, [domain.domain]);
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
        failureReason,
        tlsStatus: "ERROR",
        lastProviderSyncAt: new Date(),
        lastCheckedAt: checkedAt,
      },
    });
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

  await invalidateWebsiteRouting(website.id, website.subdomain, [domain.domain]);
  return updated;
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
  const { website, domain } = await getOwnedDomain(domainId, user);
  if (domain.status !== "VERIFIED") {
    throw new AppError(status.CONFLICT, "Verify the domain before making it primary");
  }

  const updated = await prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${website.id}))`;
    await tx.websiteDomain.updateMany({
      where: { websiteId: website.id, isPrimary: true },
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
