import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { normalizeSubdomain } from "./websiteIdentity";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WEBSITE_SUBDOMAIN_RESERVATION_LOCK } from "./websiteProvisioning.service";
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

const inspectCandidate = async (subdomain: string, websiteId: string) => {
  const [website, alias] = await Promise.all([
    prisma.businessWebsite.findUnique({ where: { subdomain }, select: { id: true } }),
    prisma.websiteSubdomainAlias.findUnique({ where: { subdomain }, select: { websiteId: true } }),
  ]);

  if (website?.id === websiteId) {
    return { available: true, current: true, reclaimableAlias: false };
  }
  if (alias?.websiteId === websiteId) {
    return { available: true, current: false, reclaimableAlias: true };
  }
  return {
    available: !website && !alias,
    current: false,
    reclaimableAlias: false,
  };
};

const checkAvailability = async (input: string, user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  let subdomain: string;
  try {
    subdomain = normalizeSubdomain(input);
  } catch (error) {
    if (error instanceof AppError) {
      return {
        subdomain: input.trim().toLowerCase(),
        available: false,
        current: false,
        reclaimableAlias: false,
        reason: error.message,
      };
    }
    throw error;
  }

  const result = await inspectCandidate(subdomain, website.id);
  return {
    subdomain,
    ...result,
    reason: result.available ? null : "That subdomain is already in use",
    publicUrl: WEBSITE_BASE_DOMAIN ? `https://${subdomain}.${WEBSITE_BASE_DOMAIN}` : null,
  };
};

const rename = async (input: string, user: IRequestUser) => {
  const owned = await getOwnedWebsite(user);
  const nextSubdomain = normalizeSubdomain(input);
  if (nextSubdomain === owned.subdomain) {
    return {
      subdomain: owned.subdomain,
      previousSubdomain: owned.subdomain,
      changed: false,
      aliasCreated: false,
      publicUrl: WEBSITE_BASE_DOMAIN ? `https://${owned.subdomain}.${WEBSITE_BASE_DOMAIN}` : null,
    };
  }

  const result = await prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, owned.id);
    await acquireTextTransactionAdvisoryLock(tx, WEBSITE_SUBDOMAIN_RESERVATION_LOCK);

    // Re-read after both locks; another request may have renamed this website
    // while this request was waiting.
    const current = await tx.businessWebsite.findUnique({
      where: { id: owned.id },
      select: { id: true, subdomain: true },
    });
    if (!current) throw new AppError(status.NOT_FOUND, "Business website not found");
    if (nextSubdomain === current.subdomain) {
      return { previousSubdomain: current.subdomain, subdomain: current.subdomain, changed: false, aliasCreated: false };
    }

    const [occupiedWebsite, occupiedAlias] = await Promise.all([
      tx.businessWebsite.findUnique({ where: { subdomain: nextSubdomain }, select: { id: true } }),
      tx.websiteSubdomainAlias.findUnique({ where: { subdomain: nextSubdomain }, select: { id: true, websiteId: true } }),
    ]);
    if (occupiedWebsite && occupiedWebsite.id !== current.id) {
      throw new AppError(status.CONFLICT, "That subdomain is already in use");
    }
    if (occupiedAlias && occupiedAlias.websiteId !== current.id) {
      throw new AppError(status.CONFLICT, "That subdomain is already in use");
    }

    // Reclaiming one of this website's own historical aliases is safe and
    // makes rename reversible without building alias chains.
    if (occupiedAlias?.websiteId === current.id) {
      await tx.websiteSubdomainAlias.delete({ where: { id: occupiedAlias.id } });
    }

    // The old canonical label becomes a permanent alias before the canonical
    // row changes, all inside the same transaction.
    await tx.websiteSubdomainAlias.create({
      data: {
        websiteId: current.id,
        subdomain: current.subdomain,
        redirectCode: 308,
      },
    });
    await tx.businessWebsite.update({
      where: { id: current.id },
      data: { subdomain: nextSubdomain },
    });

    return {
      previousSubdomain: current.subdomain,
      subdomain: nextSubdomain,
      changed: true,
      aliasCreated: true,
    };
  });

  const [customDomains, aliases] = await Promise.all([
    prisma.websiteDomain.findMany({
      where: { websiteId: owned.id, status: "VERIFIED" as any },
      select: { domain: true },
    }),
    prisma.websiteSubdomainAlias.findMany({
      where: { websiteId: owned.id },
      select: { subdomain: true },
    }),
  ]);

  // Every historical alias can contain a cached canonicalHost from before the
  // rename. Invalidate all aliases, not just old/new, otherwise an older alias
  // can temporarily create a 308 -> 308 redirect chain until its Redis TTL
  // expires. Database aliases always point directly at the current website.
  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([
      result.previousSubdomain,
      result.subdomain,
      ...aliases.map((item) => item.subdomain),
    ]),
    WebsiteHostResolverService.invalidateHosts(customDomains.map((item) => item.domain)),
    WebsiteProjectionCacheService.invalidateWebsite(owned.id),
  ]);

  return {
    ...result,
    publicUrl: WEBSITE_BASE_DOMAIN ? `https://${result.subdomain}.${WEBSITE_BASE_DOMAIN}` : null,
  };
};

export const SubdomainService = { checkAvailability, rename };
