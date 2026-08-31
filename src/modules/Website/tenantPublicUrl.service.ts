import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_CUSTOM_DOMAINS_ENABLED } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";
import { readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import {
  deriveWebsiteEntitlements,
  websiteEntitlementSubscriptionSelect,
} from "./websiteEntitlement.service";

export interface TenantPublicUrlResolution {
  websiteId: string;
  subdomain: string;
  customDomain: string | null;
  origin: string;
}

const resolveForAdminId = async (
  adminId: string,
): Promise<TenantPublicUrlResolution> => {
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: {
      id: true,
      subdomain: true,
      domains: {
        where: {
          isPrimary: true,
          ...readyWebsiteDomainWhere,
        },
        select: { domain: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
      admin: {
        select: {
          subscription: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: websiteEntitlementSubscriptionSelect,
          },
        },
      },
    },
  });

  if (!website) {
    throw new AppError(
      status.CONFLICT,
      "A business website is required before public client links can be shared.",
      {
        code: "WEBSITE_REQUIRED_FOR_PUBLIC_LINK",
        retryable: false,
      },
    );
  }

  const entitlements = deriveWebsiteEntitlements(
    website.admin.subscription[0] ?? null,
  );
  const customDomain =
    WEBSITE_CUSTOM_DOMAINS_ENABLED &&
    entitlements.customDomains &&
    entitlements.customDomainLimit > 0
      ? website.domains[0]?.domain ?? null
      : null;
  const origin = getCanonicalWebsiteOrigin(website.subdomain, customDomain);

  if (!origin) {
    throw new AppError(
      status.SERVICE_UNAVAILABLE,
      "The public website address is not available right now. Please try again shortly.",
      {
        code: "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE",
        retryable: true,
      },
    );
  }

  return {
    websiteId: website.id,
    subdomain: website.subdomain,
    customDomain,
    origin,
  };
};

const buildRootDocumentUrl = (
  resolution: Pick<TenantPublicUrlResolution, "origin">,
  publicDocumentToken: string,
): string => {
  const cleanToken = publicDocumentToken.trim();
  if (!cleanToken) {
    throw new AppError(status.INTERNAL_SERVER_ERROR, "Public document token is missing", {
      code: "PUBLIC_DOCUMENT_TOKEN_MISSING",
      retryable: false,
    });
  }

  return `${resolution.origin.replace(/\/+$/, "")}/${encodeURIComponent(cleanToken)}`;
};

const buildRootDocumentUrlForAdmin = async (
  adminId: string,
  publicDocumentToken: string,
): Promise<string> =>
  buildRootDocumentUrl(await resolveForAdminId(adminId), publicDocumentToken);

export const TenantPublicUrlService = {
  resolveForAdminId,
  buildRootDocumentUrl,
  buildRootDocumentUrlForAdmin,
};
