import { prisma } from "../../lib/prisma/prisma";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CUSTOM_DOMAINS_ENABLED, WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE, WEBSITE_DOMAIN_PROVIDER } from "../../config/ENV";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { Prisma } from "../../generated/prisma/client";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteService } from "./website.service";
import { buildWebsitePublicationFingerprint, parsePublishedSnapshot } from "./websiteSnapshot";
import { buildDefaultWebsiteSeo } from "./websiteSeo";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";
import { isWebsiteDomainRoutingReady, readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";
import { WebsiteOverviewService } from "./websiteOverview.service";

type WebsiteStudioDomain = Parameters<typeof isWebsiteDomainRoutingReady>[0] & {
  id: string;
  [key: string]: unknown;
};

const primaryReadyWebsiteDomainWhere = {
  isPrimary: true,
  ...readyWebsiteDomainWhere,
} satisfies Prisma.WebsiteDomainWhereInput;

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
        websiteDesign: true,
        publishedAt: true,
        publishedSnapshot: true,
        publishedRevisionNumber: true,
        draftRevisionNumber: true,
        metaTitle: true,
        primaryBookingFormId: true,
        bookingEnabled: true,
        pages: {
          where: { kind: "HOME" },
          select: { isEnabled: true },
          take: 1,
        },
        domains: {
          where: primaryReadyWebsiteDomainWhere,
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
  const maxRevision = await prisma.websiteRevision.aggregate({
    where: { websiteId: website.id },
    _max: { revisionNumber: true },
  });
  const maxNum = Number(maxRevision?._max?.revisionNumber ?? 0);
  const draftRevisionNumber = Math.max(Number(website.draftRevisionNumber ?? 0), maxNum);
  const businessName = business?.businessName?.trim() || "Your cleaning business";
  const publishedSnapshot = parsePublishedSnapshot(website.publishedSnapshot);
  const publicationFingerprint = buildWebsitePublicationFingerprint({
    websiteId: website.id,
    draftRevisionNumber,
    publishedRevisionNumber: website.publishedRevisionNumber,
    publishedAt: website.publishedAt,
    templateId: website.templateId,
    templateVersion: website.templateVersion,
    websiteDesign: website.websiteDesign,
    publishedSnapshot,
  });

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
      publicationFingerprint,
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

  type StudioBootstrapRow = {
    businessName: string | null;
    city: string | null;
    businessDescription: string | null;
    websiteStatus: string | null;
    publishedSnapshot: unknown;
    bookingForms: Array<{ id: string; slug: string; published: boolean; headline: string | null }>;
    estimateForms: Array<{ id: string; slug: string; published: boolean; headline: string | null }>;
  };

  // Business identity + the two form lists are one read model. This replaces
  // three Prisma round trips on every Studio open while keeping the heavier
  // website/domain aggregate and entitlement services independently cacheable.
  const [website, bootstrapRows, entitlements, overview] = await Promise.all([
    WebsiteService.getWebsiteForAdmin(adminId),
    prisma.$queryRaw<StudioBootstrapRow[]>`
      SELECT
        ap."businessName",
        ap.city,
        ap."businessDescription",
        bw.status::text AS "websiteStatus",
        bw."publishedSnapshot",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', bf.id, 'slug', bf.slug, 'published', bf.published, 'headline', bf.headline
          ) ORDER BY bf.published DESC, bf."updatedAt" DESC)
          FROM (
            SELECT id, slug, published, headline, "updatedAt"
            FROM "booking_form"
            WHERE "adminId" = ${adminId}
            ORDER BY published DESC, "updatedAt" DESC
            LIMIT 100
          ) bf
        ), '[]'::jsonb) AS "bookingForms",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', ef.id, 'slug', ef.slug, 'published', ef.published, 'headline', ef.headline
          ) ORDER BY ef.published DESC, ef."updatedAt" DESC)
          FROM (
            SELECT id, slug, published, headline, "updatedAt"
            FROM "estimate_form"
            WHERE "adminId" = ${adminId}
            ORDER BY published DESC, "updatedAt" DESC
            LIMIT 100
          ) ef
        ), '[]'::jsonb) AS "estimateForms"
      FROM "AdminProfile" ap
      LEFT JOIN "business_website" bw ON bw."adminId" = ap.id
      WHERE ap.id = ${adminId}
      LIMIT 1
    `,
    WebsiteEntitlementService.getForAdminId(adminId),
    WebsiteOverviewService.getForAdminId(adminId),
  ]);

  const business = bootstrapRows[0] ?? null;
  const bookingForms = business?.bookingForms ?? [];
  const estimateForms = business?.estimateForms ?? [];
  const published = parsePublishedSnapshot(business?.publishedSnapshot);
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
        business?.websiteStatus === "PUBLISHED" &&
        published?.website.bookingEnabled &&
        publishedBookPageEnabled &&
        publishedBookingForm,
      ),
      publishedBookingFormId: publishedBookingForm?.id ?? null,
      publishedBookingFormHeadline: publishedBookingForm?.headline ?? null,
    },
    estimate: {
      live: Boolean(
        business?.websiteStatus === "PUBLISHED" &&
        published?.website.estimateEnabled &&
        publishedEstimatePageEnabled &&
        publishedEstimateForm,
      ),
      publishedEstimateFormId: publishedEstimateForm?.id ?? null,
      publishedEstimateFormHeadline: publishedEstimateForm?.headline ?? null,
    },
    templates: TemplateRegistry.listSelectable().map((template) => ({
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
