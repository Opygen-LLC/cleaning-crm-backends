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

const platformUrl = (subdomain: string) =>
  WEBSITE_BASE_DOMAIN ? `https://${subdomain}.${WEBSITE_BASE_DOMAIN}` : null;

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
        publicUrl: null,
      };
    }
    throw error;
  }

  const result = await inspectCandidate(subdomain, website.id);
  return {
    subdomain,
    ...result,
    reason: result.available ? null : "That subdomain is already in use",
    publicUrl: platformUrl(subdomain),
  };
};

/**
 * Populate the two routing entries affected by a rename after invalidation.
 * This is best-effort only; Postgres remains authoritative and a cache outage
 * must never turn a successful domain mutation into an API failure.
 */
const warmRenamedRoutes = async (previousSubdomain: string, subdomain: string) => {
  if (!WEBSITE_BASE_DOMAIN) return;
  await Promise.allSettled([
    WebsiteHostResolverService.resolveHost(`${subdomain}.${WEBSITE_BASE_DOMAIN}`),
    WebsiteHostResolverService.resolveHost(`${previousSubdomain}.${WEBSITE_BASE_DOMAIN}`),
  ]);
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
      alias: null,
      redirectCode: null,
      publicUrl: platformUrl(owned.subdomain),
      previousPublicUrl: platformUrl(owned.subdomain),
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock this website first, then the shared reservation namespace. All
    // subdomain mutations in this service use the same ordering so concurrent
    // retries cannot interleave the canonical row and alias history.
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
      return {
        previousSubdomain: current.subdomain,
        subdomain: current.subdomain,
        changed: false,
        aliasCreated: false,
        alias: null,
      };
    }

    const [occupiedWebsite, occupiedAlias, currentAlias] = await Promise.all([
      tx.businessWebsite.findUnique({ where: { subdomain: nextSubdomain }, select: { id: true } }),
      tx.websiteSubdomainAlias.findUnique({
        where: { subdomain: nextSubdomain },
        select: { id: true, websiteId: true },
      }),
      tx.websiteSubdomainAlias.findUnique({
        where: { subdomain: current.subdomain },
        select: { id: true, websiteId: true },
      }),
    ]);

    if (occupiedWebsite && occupiedWebsite.id !== current.id) {
      throw new AppError(status.CONFLICT, "That subdomain is already in use");
    }
    if (occupiedAlias && occupiedAlias.websiteId !== current.id) {
      throw new AppError(status.CONFLICT, "That subdomain is already in use");
    }
    if (currentAlias && currentAlias.websiteId !== current.id) {
      // This should never be possible through supported allocation paths, but
      // fail closed rather than stealing another tenant's historical hostname.
      throw new AppError(status.CONFLICT, "The current website address has a conflicting historical alias");
    }

    // Reclaiming one of this website's own historical aliases is safe and
    // makes rename reversible without building alias chains.
    if (occupiedAlias?.websiteId === current.id) {
      await tx.websiteSubdomainAlias.delete({ where: { id: occupiedAlias.id } });
    }

    // The old canonical label becomes a permanent alias before the canonical
    // row changes, all inside the same transaction. If an old inconsistent row
    // for this exact website already exists, repair/reuse it rather than
    // failing the rename on a unique constraint.
    const alias = currentAlias?.websiteId === current.id
      ? await tx.websiteSubdomainAlias.update({
          where: { id: currentAlias.id },
          data: { redirectCode: 308 },
        })
      : await tx.websiteSubdomainAlias.create({
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
      aliasCreated: !currentAlias,
      alias,
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

  await warmRenamedRoutes(result.previousSubdomain, result.subdomain);

  return {
    ...result,
    redirectCode: result.changed ? 308 : null,
    publicUrl: platformUrl(result.subdomain),
    previousPublicUrl: platformUrl(result.previousSubdomain),
  };
};

export const SubdomainService = { checkAvailability, rename };
