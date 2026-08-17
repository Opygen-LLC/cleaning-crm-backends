import { prisma } from "../../lib/prisma/prisma";
import { WEBSITE_CUSTOM_DOMAINS_ENABLED, WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE, WEBSITE_DOMAIN_PROVIDER } from "../../config/ENV";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteService } from "./website.service";
import { parsePublishedSnapshot } from "./websiteSnapshot";
import { buildDefaultWebsiteSeo } from "./websiteSeo";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";
import { isWebsiteDomainRoutingReady } from "./websiteDomainReadiness";
import { WebsiteOverviewService } from "./websiteOverview.service";

type WebsiteStudioDomain = Parameters<typeof isWebsiteDomainRoutingReady>[0] & {
  id: string;
  [key: string]: unknown;
};

/**
 * Lightweight read model for Website Studio.
 *
 * The editor previously loaded the website, templates, booking forms,
 * estimate forms and domains through separate browser requests. This endpoint
 * deliberately returns only the form fields the Studio needs and reuses the
 * website aggregate for domains, cutting request fan-out and avoiding the
 * expensive form-list submission statistics queries.
 */
const getStudio = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const [website, business, bookingForms, estimateForms, entitlements, overview] = await Promise.all([
    WebsiteService.getWebsiteForAdmin(adminId),
    prisma.adminProfile.findUnique({
      where: { id: adminId },
      select: {
        businessName: true,
        city: true,
        businessDescription: true,
        businessWebsite: {
          select: { status: true, publishedSnapshot: true },
        },
      },
    }),
    prisma.bookingForm.findMany({
      where: { adminId },
      select: { id: true, slug: true, published: true, headline: true },
      orderBy: [{ published: "desc" }, { updatedAt: "desc" }],
      take: 100,
    }),
    prisma.estimateForm.findMany({
      where: { adminId },
      select: { id: true, slug: true, published: true, headline: true },
      orderBy: [{ published: "desc" }, { updatedAt: "desc" }],
      take: 100,
    }),
    WebsiteEntitlementService.getForAdminId(adminId),
    WebsiteOverviewService.getForAdminId(adminId),
  ]);

  const published = parsePublishedSnapshot(business?.businessWebsite?.publishedSnapshot);
  const publishedBookingFormId = published?.website.bookingEnabled
    ? published.website.primaryBookingFormId
    : null;
  const publishedBookingForm = publishedBookingFormId
    ? bookingForms.find((form) => form.id === publishedBookingFormId && form.published) ?? null
    : null;
  const publishedBookPageEnabled = Boolean(
    published?.pages.some((page) => page.kind === "BOOK" && page.isEnabled),
  );
  const publishedEstimateFormId = published?.website.estimateEnabled
    ? published.website.primaryEstimateFormId
    : null;
  const publishedEstimateForm = publishedEstimateFormId
    ? estimateForms.find((form) => form.id === publishedEstimateFormId && form.published) ?? null
    : null;
  const publishedEstimatePageEnabled = Boolean(
    published?.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled),
  );

  // WebsiteService deliberately presents domains as an API-safe read model.
  // Its database adapter is intentionally generic, so establish the minimum
  // routing-ready shape once here instead of letting callback parameters fall
  // through to implicit `any` under strict TypeScript settings.
  const websiteDomains = website.domains as WebsiteStudioDomain[];
  const allowedReadyDomainIds = new Set(
    WEBSITE_CUSTOM_DOMAINS_ENABLED && entitlements.customDomains && entitlements.customDomainLimit > 0
      ? websiteDomains
          .filter((domain) => isWebsiteDomainRoutingReady(domain))
          .slice(0, entitlements.customDomainLimit)
          .map((domain) => domain.id)
      : [],
  );
  const studioWebsite = {
    ...website,
    domains: websiteDomains.map((domain) => ({
      ...domain,
      entitlementActive:
        isWebsiteDomainRoutingReady(domain) && allowedReadyDomainIds.has(domain.id),
    })),
    publicUrl:
      WEBSITE_CUSTOM_DOMAINS_ENABLED &&
      entitlements.customDomains &&
      entitlements.customDomainLimit > 0
        ? website.publicUrl
        : website.platformUrl,
  };

  const businessName = business?.businessName?.trim() || "Your cleaning business";
  const seoDefaults = buildDefaultWebsiteSeo({
    businessName,
    city: business?.city ?? null,
    businessDescription: business?.businessDescription ?? null,
  });

  return {
    website: studioWebsite,
    business: {
      name: businessName,
      city: business?.city?.trim() || null,
    },
    seoDefaults,
    overview,
    booking: {
      live: Boolean(
        business?.businessWebsite?.status === "PUBLISHED" &&
        published?.website.bookingEnabled &&
        publishedBookPageEnabled &&
        publishedBookingForm,
      ),
      publishedBookingFormId: publishedBookingForm?.id ?? null,
      publishedBookingFormHeadline: publishedBookingForm?.headline ?? null,
    },
    estimate: {
      live: Boolean(
        business?.businessWebsite?.status === "PUBLISHED" &&
        published?.website.estimateEnabled &&
        publishedEstimatePageEnabled &&
        publishedEstimateForm,
      ),
      publishedEstimateFormId: publishedEstimateForm?.id ?? null,
      publishedEstimateFormHeadline: publishedEstimateForm?.headline ?? null,
    },
    templates: TemplateRegistry.list().map((template) => ({
      ...template,
      available: template.tier === "FREE" || entitlements.premiumTemplates,
      lockedReason: template.tier === "PRO" && !entitlements.premiumTemplates
        ? "Upgrade your plan to use premium website templates."
        : null,
    })),
    bookingForms,
    estimateForms,
    features: {
      customDomainsEnabled:
        WEBSITE_CUSTOM_DOMAINS_ENABLED &&
        entitlements.customDomains &&
        entitlements.customDomainLimit > 0,
      customDomainsDeploymentEnabled: WEBSITE_CUSTOM_DOMAINS_ENABLED,
      customDomainLimitPerSite: Math.min(WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE, entitlements.customDomainLimit),
      customDomainProvider: WEBSITE_DOMAIN_PROVIDER.toUpperCase(),
      entitlements,
    },
  };
};

export const WebsiteStudioService = { getStudio };
