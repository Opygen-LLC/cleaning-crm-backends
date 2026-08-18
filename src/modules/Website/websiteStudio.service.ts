import { prisma } from "../../lib/prisma/prisma";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CUSTOM_DOMAINS_ENABLED, WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE, WEBSITE_DOMAIN_PROVIDER } from "../../config/ENV";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteService } from "./website.service";
import { parsePublishedSnapshot } from "./websiteSnapshot";
import { buildDefaultWebsiteSeo } from "./websiteSeo";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";
import { isWebsiteDomainRoutingReady, readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";
import { WebsiteOverviewService } from "./websiteOverview.service";

type WebsiteStudioDomain = Parameters<typeof isWebsiteDomainRoutingReady>[0] & {
  id: string;
  [key: string]: unknown;
};

const getOverview = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const [website, business, overview, entitlements] = await Promise.all([
    prisma.businessWebsite.findUnique({
      where: { adminId },
      select: {
        id: true,
        status: true,
        subdomain: true,
        templateId: true,
        templateVersion: true,
        publishedAt: true,
        publishedRevisionNumber: true,
        metaTitle: true,
        primaryBookingFormId: true,
        bookingEnabled: true,
        pages: {
          where: { kind: "HOME" },
          select: { isEnabled: true },
          take: 1,
        },
        revisions: {
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
          take: 1,
        },
        domains: {
          where: { isPrimary: true, ...readyWebsiteDomainWhere },
          select: { domain: true },
          take: 1,
        },
      },
    }),
    prisma.adminProfile.findUnique({
      where: { id: adminId },
      select: { businessName: true, city: true, businessDescription: true },
    }),
    WebsiteOverviewService.getForAdminId(adminId),
    WebsiteEntitlementService.getForAdminId(adminId),
  ]);

  if (!website) return null;

  const template = TemplateRegistry.requireTemplate(website.templateId, website.templateVersion);
  const platformUrl = WEBSITE_BASE_DOMAIN
    ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}`
    : null;
  const primaryCustomDomain =
    WEBSITE_CUSTOM_DOMAINS_ENABLED && entitlements.customDomains && entitlements.customDomainLimit > 0
      ? website.domains[0]?.domain ?? null
      : null;
  const publicUrl = getCanonicalWebsiteOrigin(website.subdomain, primaryCustomDomain);
  const draftRevisionNumber = website.revisions[0]?.revisionNumber ?? 0;
  const businessName = business?.businessName?.trim() || "Your cleaning business";

  return {
    website: {
      id: website.id,
      status: website.status,
      subdomain: website.subdomain,
      platformUrl,
      publicUrl,
      templateId: website.templateId,
      templateVersion: website.templateVersion,
      templateName: template.name,
      publishedAt: website.publishedAt,
      publishedRevisionNumber: website.publishedRevisionNumber,
      draftRevisionNumber,
      hasUnpublishedChanges:
        website.publishedRevisionNumber === null ||
        draftRevisionNumber > website.publishedRevisionNumber,
    },
    business: { name: businessName, city: business?.city?.trim() || null },
    seoDefaults: buildDefaultWebsiteSeo({
      businessName,
      city: business?.city ?? null,
      businessDescription: business?.businessDescription ?? null,
    }),
    overview,
    readiness: {
      templateSelected: Boolean(template),
      homePageEnabled: Boolean(website.pages[0]?.isEnabled),
      onlineBookingConnected: Boolean(website.bookingEnabled && website.primaryBookingFormId),
      seoTitleAdded: Boolean(website.metaTitle?.trim()),
      publicAddressReady: Boolean(publicUrl),
    },
    features: {
      customDomainsEnabled:
        WEBSITE_CUSTOM_DOMAINS_ENABLED &&
        entitlements.customDomains &&
        entitlements.customDomainLimit > 0,
      customDomainsDeploymentEnabled: WEBSITE_CUSTOM_DOMAINS_ENABLED,
      customDomainLimitPerSite: Math.min(
        WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE,
        entitlements.customDomainLimit,
      ),
      customDomainProvider: WEBSITE_DOMAIN_PROVIDER.toUpperCase(),
      entitlements,
    },
  };
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

export const WebsiteStudioService = { getOverview, getStudio };
