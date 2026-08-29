import status from "http-status";
import AppError from "../../errorHelper/AppError";
import logger from "../../lib/logger";
import { prisma } from "../../lib/prisma/prisma";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { TemplateRegistry } from "./templateRegistry";
import { buildPublishedSnapshot, parsePublishedSnapshot, parseRevisionSnapshotAsPublished, type WebsitePublishedSnapshotV1 } from "./websiteSnapshot";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { buildDefaultWebsiteSeo } from "./websiteSeo";
import { getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";
import { deriveWebsiteEntitlements, websiteEntitlementSubscriptionSelect } from "./websiteEntitlement.service";

const WEBSITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResolvedWebsite {
  websiteId: string;
  aliasRedirectSubdomain: string | null;
}

const resolveIdentifier = async (identifier: string): Promise<ResolvedWebsite> => {
  const raw = identifier.trim();
  if (!raw) throw new AppError(status.NOT_FOUND, "Website not found");

  // Full hosts and custom domains share the same resolver/cache used by edge
  // routing. This prevents the public service from maintaining a second, DB-
  // only hostname resolution path and also supports callers that pass the full
  // platform hostname instead of only the tenant label.
  if (raw.includes(".")) {
    let resolved: Awaited<ReturnType<typeof WebsiteHostResolverService.resolveHost>>;
    try {
      resolved = await WebsiteHostResolverService.resolveHost(raw);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === status.NOT_FOUND) {
        throw new AppError(status.NOT_FOUND, "Website not found");
      }
      throw error;
    }
    return {
      websiteId: resolved.websiteId,
      aliasRedirectSubdomain:
        resolved.routeKind === "subdomain_alias" ? resolved.canonicalSubdomain : null,
    };
  }

  const resolved = await WebsiteHostResolverService.resolveSubdomain(raw);
  return {
    websiteId: resolved.websiteId,
    aliasRedirectSubdomain: resolved.isAlias ? resolved.canonicalSubdomain : null,
  };
};

const loadProjectionSource = async (websiteId: string, options: { includeDraftPages?: boolean } = {}) => {
  const website: any = await prisma.businessWebsite.findUnique({
    where: { id: websiteId },
    include: {
      admin: {
        select: {
          id: true,
          businessName: true,
          businessLogo: true,
          mobileNumber: true,
          businessEmail: true,
          businessDescription: true,
          businessHours: true,
          address: true,
          city: true,
          zipcode: true,
          country: true,
          brandColor: true,
          currency: true,
          user: { select: { email: true, status: true } },
          subscription: { orderBy: { createdAt: "desc" }, take: 1, select: websiteEntitlementSubscriptionSelect },
          serviceCatalogs: {
            where: { status: "ACTIVE" as any },
            select: {
              id: true,
              serviceName: true,
              description: true,
              basePrice: true,
              duration: true,
              category: true,
              addOns: true,
              legacyServiceType: true,
              onlineBookingEnabled: true,
            },
            orderBy: [{ category: "asc" }, { serviceName: "asc" }],
            take: 200,
          },
          reviews: {
            // Publication status is the single moderation source of truth.
            where: { status: "published", staffId: null },
            select: {
              clientName: true,
              rating: true,
              comment: true,
              adminReply: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          workLocations: {
            select: { city: true, postcode: true },
            orderBy: { createdAt: "asc" },
          },
          // Only published forms can power the public runtime. The snapshot
          // still chooses which tenant-owned form is active, but loading only
          // published forms prevents unused drafts from inflating the payload.
          bookingForms: {
            where: { published: true },
            select: { id: true, slug: true, published: true, headline: true, subheading: true },
          },
          estimateForms: {
            where: { published: true },
            select: { id: true, slug: true, published: true, headline: true, subheading: true },
          },
        },
      },
      pages: options.includeDraftPages === false ? false : {
        select: { kind: true, slug: true, title: true, content: true, seoTitle: true, seoDescription: true, showInNavigation: true, isEnabled: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      domains: {
        where: readyWebsiteDomainWhere as any,
        select: { domain: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!website) throw new AppError(status.NOT_FOUND, "Website not found");

  // Remember the one-to-one admin → website mapping in Redis so subsequent CRM
  // mutations can invalidate the public projection without first querying the
  // BusinessWebsite table. This is best-effort and never affects correctness.
  await WebsiteProjectionCacheService.rememberAdminWebsite(website.adminId, website.id);

  // Keep the review list bounded for payload size, but calculate the public
  // aggregate across every published tenant review so businesses with >50
  // reviews never display an incorrect rating/count. This is only paid on a
  // website projection cache miss.
  const reviewAggregate = await prisma.review.aggregate({
    where: {
      adminId: website.adminId,
      status: "published",
      staffId: null,
    },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const averageRating = reviewAggregate._avg.rating;
  return {
    website,
    reviewSummary: {
      averageRating: averageRating === null ? null : Math.round(averageRating * 10) / 10,
      count: reviewAggregate._count._all,
    },
  };
};

const currentDraftAsPublishedSnapshot = (website: any) => buildPublishedSnapshot({
  templateId: website.templateId,
  templateVersion: website.templateVersion,
  schemaVersion: website.schemaVersion,
  primaryColor: website.primaryColor,
  secondaryColor: website.secondaryColor,
  accentColor: website.accentColor,
  font: website.font,
  logo: website.logo,
  favicon: website.favicon,
  primaryBookingFormId: website.primaryBookingFormId,
  primaryEstimateFormId: website.primaryEstimateFormId,
  bookingEnabled: website.bookingEnabled,
  bookingShowNavigation: website.bookingShowNavigation,
  bookingShowHeaderCta: website.bookingShowHeaderCta,
  bookingShowServiceCtas: website.bookingShowServiceCtas,
  bookingShowHomeCta: website.bookingShowHomeCta,
  bookingShowAvailableSlots: website.bookingShowAvailableSlots,
  bookingShowPrices: website.bookingShowPrices,
  bookingShowStartingPrices: website.bookingShowStartingPrices,
  bookingShowServiceDuration: website.bookingShowServiceDuration,
  bookingCtaLabel: website.bookingCtaLabel,
  estimateEnabled: website.estimateEnabled,
  metaTitle: website.metaTitle,
  metaDescription: website.metaDescription,
  socialImageUrl: website.socialImageUrl,
  indexSite: website.indexSite,
  pages: website.pages,
});


/**
 * Public rendering must never cross the immutable publish boundary. A legacy or
 * corrupted publishedSnapshot is recovered only from the exact recorded live
 * revision (or a historical publish/launch revision when the revision pointer
 * itself is missing). The current draft is intentionally never considered.
 */
const resolveSafePublishedSnapshot = async (website: any): Promise<WebsitePublishedSnapshotV1> => {
  const direct = parsePublishedSnapshot(website.publishedSnapshot);
  if (direct) return direct;

  if (website.status !== "PUBLISHED") {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  if (Number.isInteger(website.publishedRevisionNumber) && website.publishedRevisionNumber > 0) {
    const exactRevision = await prisma.websiteRevision.findFirst({
      where: { websiteId: website.id, revisionNumber: website.publishedRevisionNumber },
      select: { revisionNumber: true, snapshot: true, reason: true },
    });
    const recovered = exactRevision ? parseRevisionSnapshotAsPublished(exactRevision.snapshot) : null;
    if (recovered) {
      logger.warn(
        `[public-website] recovered invalid publishedSnapshot for ${website.id} from revision #${exactRevision?.revisionNumber}`,
      );
      return recovered;
    }
  }

  // Older PUBLISHED rows may predate publishedRevisionNumber. Search only
  // revisions explicitly created by Publish/Launch; a Draft saved/Restored
  // revision is never eligible because it may contain private edits.
  const historical = await prisma.websiteRevision.findMany({
    where: { websiteId: website.id },
    select: { revisionNumber: true, snapshot: true, reason: true },
    orderBy: { revisionNumber: "desc" },
    take: 50,
  });
  for (const revision of historical) {
    if (!/publish|launch/i.test(revision.reason ?? "")) continue;
    const recovered = parseRevisionSnapshotAsPublished(revision.snapshot);
    if (!recovered) continue;
    logger.warn(
      `[public-website] recovered invalid publishedSnapshot for ${website.id} from historical publish revision #${revision.revisionNumber}`,
    );
    return recovered;
  }

  throw new AppError(status.SERVICE_UNAVAILABLE, "Website publication is temporarily unavailable", {
    code: "WEBSITE_PUBLISHED_SNAPSHOT_INVALID",
    retryable: false,
  });
};

const resolveCompatibleBackendTemplate = (config: WebsitePublishedSnapshotV1["website"]) => {
  const exact = TemplateRegistry.get(config.templateId, config.templateVersion);
  if (exact) return exact;

  // Rolling deploy/rollback compatibility: presentation may fall back only to
  // a renderer that declares the same content schema. Never render schema v2
  // content through a v1 template merely to avoid a 503.
  const sameFamily = TemplateRegistry.get(config.templateId);
  if (sameFamily?.schemaVersion === config.schemaVersion) return sameFamily;

  const safeDefault = TemplateRegistry.get("clean-modern");
  return safeDefault?.schemaVersion === config.schemaVersion ? safeDefault : null;
};

const projectWebsite = (
  source: Awaited<ReturnType<typeof loadProjectionSource>>,
  options: { mode: "public" | "preview"; aliasRedirectSubdomain?: string | null; snapshotOverride?: WebsitePublishedSnapshotV1 | null },
) => {
  const { website, reviewSummary } = source;

  if (options.mode === "public") {
    if (website.status === "SUSPENDED" || website.admin.user.status !== "ACTIVE") {
      throw new AppError(status.SERVICE_UNAVAILABLE, "Website temporarily unavailable");
    }
    if (website.status !== "PUBLISHED") throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const snapshot = options.snapshotOverride ?? (options.mode === "preview"
    ? currentDraftAsPublishedSnapshot(website)
    : parsePublishedSnapshot(website.publishedSnapshot));
  if (!snapshot) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website publication is temporarily unavailable", {
      code: "WEBSITE_PUBLISHED_SNAPSHOT_INVALID",
      retryable: false,
    });
  }

  const config = snapshot.website;
  const pages = snapshot.pages.filter((page) => page.isEnabled);
  const entitlements = deriveWebsiteEntitlements(website.admin.subscription[0] as any);
  const requestedTemplate = resolveCompatibleBackendTemplate(config);
  if (!requestedTemplate) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website template schema is unavailable", {
      code: "WEBSITE_TEMPLATE_SCHEMA_UNAVAILABLE",
      retryable: false,
    });
  }
  // Subscription downgrade changes presentation only; CRM/content/domain rows are
  // never destroyed. Upgrading restores the selected premium template. The
  // fallback must support the same schema as the published content.
  const defaultTemplate = TemplateRegistry.get("clean-modern");
  const downgradeFallback = defaultTemplate?.schemaVersion === config.schemaVersion ? defaultTemplate : null;
  if (requestedTemplate.tier === "PRO" && !entitlements.premiumTemplates && !downgradeFallback) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website template schema is unavailable", {
      code: "WEBSITE_TEMPLATE_SCHEMA_UNAVAILABLE",
      retryable: false,
    });
  }
  const template = requestedTemplate.tier === "PRO" && !entitlements.premiumTemplates
    ? downgradeFallback!
    : requestedTemplate;

  // Canonical SEO and canonical routing share the exact same primary-domain
  // decision. Phase 17 guarantees that isPrimary is only retained on a
  // routing-ready custom domain (and automatically promotes the first healthy
  // domain), while additional healthy domains remain aliases.
  const primaryDomain = entitlements.customDomains && entitlements.customDomainLimit > 0
    ? website.domains.find((domain: { isPrimary: boolean; domain: string }) => domain.isPrimary)?.domain ?? null
    : null;
  const canonicalUrl = getCanonicalWebsiteOrigin(website.subdomain, primaryDomain);

  const defaultSeo = buildDefaultWebsiteSeo({
    businessName: website.admin.businessName,
    city: website.admin.city,
    businessDescription: website.admin.businessDescription,
  });

  const selectedBookingForm = config.primaryBookingFormId
    ? website.admin.bookingForms.find((form: { id: string; slug: string; published: boolean; headline: string | null; subheading: string | null }) => form.id === config.primaryBookingFormId) ?? null
    : null;
  const selectedEstimateForm = config.primaryEstimateFormId
    ? website.admin.estimateForms.find((form: { id: string; slug: string; published: boolean; headline: string | null; subheading: string | null }) => form.id === config.primaryEstimateFormId) ?? null
    : null;
  const bookingEnabled = config.bookingEnabled && Boolean(selectedBookingForm?.published);
  const estimateEnabled = config.estimateEnabled && Boolean(selectedEstimateForm?.published);

  return {
    website: {
      id: website.id,
      subdomain: website.subdomain,
      publishedAt: website.publishedAt,
      // Preview deliberately uses the public projection contract so the exact
      // Phase-3 renderer is exercised without teaching templates about admin
      // lifecycle states.
      status: "PUBLISHED" as const,
      template: {
        id: template.id,
        version: template.version,
        schemaVersion: config.schemaVersion,
        name: template.name,
        capabilities: template.capabilities,
      },
      canonicalUrl,
      redirectToSubdomain: options.aliasRedirectSubdomain ?? null,
      preview: options.mode === "preview",
    },
    business: projectPublicBusiness(website.admin),
    theme: {
      primaryColor: config.primaryColor,
      secondaryColor: config.secondaryColor,
      accentColor: config.accentColor,
      font: config.font,
      logo: config.logo ?? website.admin.businessLogo ?? null,
      favicon: config.favicon,
    },
    navigation: pages
      .filter((page) => {
        if (!page.showInNavigation) return false;
        if (page.kind === "BOOK" && (!bookingEnabled || !config.bookingShowNavigation)) return false;
        if (page.kind === "ESTIMATE" && !estimateEnabled) return false;
        return true;
      })
      .map((page) => ({ title: page.title, path: page.slug, kind: page.kind })),
    pages: pages.map((page) => ({
      kind: page.kind,
      path: page.slug,
      title: page.title,
      content: page.content,
      seoTitle: entitlements.advancedSeo ? page.seoTitle : null,
      seoDescription: entitlements.advancedSeo ? page.seoDescription : null,
    })),
    services: website.admin.serviceCatalogs.map(projectCanonicalService),
    reviews: website.admin.reviews.map((review: { clientName: string; rating: number; comment: string | null; adminReply: string | null; createdAt: Date }) => ({
      clientName: review.clientName,
      rating: review.rating,
      // Public preview/runtime contract exposes comment as a string. Legacy
      // reviews with a nullable comment are normalized at the projection edge.
      comment: review.comment ?? "",
      adminReply: review.adminReply,
      createdAt: review.createdAt,
    })),
    reviewSummary,
    serviceAreas: website.admin.workLocations.map((location: { city: string; postcode: string }) => ({
      city: location.city,
      postcode: location.postcode,
    })),
    bookingPreferences: {
      enabled: config.bookingEnabled,
      showNavigation: config.bookingShowNavigation,
      showHeaderCta: config.bookingShowHeaderCta,
      showServiceCtas: config.bookingShowServiceCtas,
      showHomeCta: config.bookingShowHomeCta,
      showAvailableSlots: config.bookingShowAvailableSlots,
      showPrices: config.bookingShowPrices,
      showStartingPrices: config.bookingShowStartingPrices,
      showServiceDuration: config.bookingShowServiceDuration,
      ctaLabel: config.bookingCtaLabel,
    },
    booking: bookingEnabled && selectedBookingForm
      ? {
          formId: selectedBookingForm.id,
          legacySlug: selectedBookingForm.slug,
          headline: selectedBookingForm.headline,
          subheading: selectedBookingForm.subheading,
          path: "/book" as const,
        }
      : null,
    estimate: estimateEnabled && selectedEstimateForm
      ? {
          formId: selectedEstimateForm.id,
          legacySlug: selectedEstimateForm.slug,
          headline: selectedEstimateForm.headline,
          subheading: selectedEstimateForm.subheading,
          path: "/estimate" as const,
        }
      : null,
    seo: {
      title: config.metaTitle?.trim() || defaultSeo.title,
      description: config.metaDescription?.trim() || defaultSeo.description,
      socialImageUrl: entitlements.advancedSeo ? config.socialImageUrl : null,
      indexSite: options.mode === "preview" ? false : config.indexSite,
      canonicalUrl,
    },
  };
};

const getPublicWebsiteById = async (websiteId: string, aliasRedirectSubdomain: string | null = null) => {
  if (!WEBSITE_ID_PATTERN.test(websiteId)) throw new AppError(status.NOT_FOUND, "Website not found");
  type PublicProjection = ReturnType<typeof projectWebsite>;
  const canonical = await WebsiteProjectionCacheService.getOrLoad<PublicProjection>(
    websiteId,
    async () => {
      const source = await loadProjectionSource(websiteId, { includeDraftPages: false });
      const publishedSnapshot = await resolveSafePublishedSnapshot(source.website);
      return projectWebsite(source, {
        mode: "public",
        aliasRedirectSubdomain: null,
        snapshotOverride: publishedSnapshot,
      });
    },
  );

  // Alias information belongs to the current request, not the canonical
  // website projection. Keep one cache entry per website and overlay only the
  // request-specific redirect hint.
  return aliasRedirectSubdomain
    ? { ...canonical, website: { ...canonical.website, redirectToSubdomain: aliasRedirectSubdomain } }
    : canonical;
};

const getPublicWebsite = async (identifier: string) => {
  const resolved = await resolveIdentifier(identifier);
  return getPublicWebsiteById(resolved.websiteId, resolved.aliasRedirectSubdomain);
};


const requireProjectionAdminId = async (websiteId: string) => {
  const adminId = await WebsiteProjectionCacheService.getAdminIdForWebsite(websiteId);
  if (!adminId) throw new AppError(status.NOT_FOUND, "Website not found");
  return adminId;
};

const resolvePublicBookingIntegration = async (identifier: string) => {
  const site = await getPublicWebsite(identifier);
  const bookPageEnabled = site.pages.some((page) => page.kind === "BOOK");
  if (!site.booking || !site.bookingPreferences.enabled || !bookPageEnabled) {
    throw new AppError(status.NOT_FOUND, "Online booking is not available on this website.", {
      code: "WEBSITE_BOOKING_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: site.website.id,
    adminId: await requireProjectionAdminId(site.website.id),
    formId: site.booking.formId,
    showAvailableSlots: site.bookingPreferences.showAvailableSlots,
    showPrices: site.bookingPreferences.showPrices,
    showStartingPrices: site.bookingPreferences.showStartingPrices,
    showServiceDuration: site.bookingPreferences.showServiceDuration,
    ctaLabel: site.bookingPreferences.ctaLabel,
  };
};

const resolvePublicEstimateIntegration = async (identifier: string) => {
  const site = await getPublicWebsite(identifier);
  const estimatePageEnabled = site.pages.some((page) => page.kind === "ESTIMATE");
  if (!site.estimate || !estimatePageEnabled) {
    throw new AppError(status.NOT_FOUND, "Online estimates are not available on this website.", {
      code: "WEBSITE_ESTIMATE_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: site.website.id,
    adminId: await requireProjectionAdminId(site.website.id),
    formId: site.estimate.formId,
  };
};

const resolvePublicContactIntegration = async (identifier: string) => {
  const site = await getPublicWebsite(identifier);
  const contactPageEnabled = site.pages.some((page) => page.kind === "CONTACT");
  if (!contactPageEnabled) {
    throw new AppError(status.NOT_FOUND, "Contact is not available on this website.", {
      code: "WEBSITE_CONTACT_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: site.website.id,
    adminId: await requireProjectionAdminId(site.website.id),
    subdomain: site.website.subdomain,
    businessName: site.business.name,
  };
};

const getPreviewWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  const source = await loadProjectionSource(website.id);
  if (source.website.admin.user.status !== "ACTIVE") {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website preview is unavailable for this account");
  }
  return projectWebsite(source, { mode: "preview" });
};

const getRevisionPreviewWebsite = async (revisionId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");

  const revision = await prisma.websiteRevision.findFirst({
    where: { id: revisionId, websiteId: website.id },
    select: { id: true, revisionNumber: true, snapshot: true },
  });
  if (!revision) throw new AppError(status.NOT_FOUND, "Website revision not found");

  const snapshot = parseRevisionSnapshotAsPublished(revision.snapshot);
  if (!snapshot) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, "This historical revision cannot be previewed safely", {
      code: "WEBSITE_REVISION_INVALID",
      retryable: false,
    });
  }

  const source = await loadProjectionSource(website.id);
  if (source.website.admin.user.status !== "ACTIVE") {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website preview is unavailable for this account");
  }
  return projectWebsite(source, { mode: "preview", snapshotOverride: snapshot });
};

export const PublicWebsiteService = {
  resolveIdentifier,
  getPublicWebsiteById,
  getPublicWebsite,
  resolvePublicBookingIntegration,
  resolvePublicEstimateIntegration,
  resolvePublicContactIntegration,
  getPreviewWebsite,
  getRevisionPreviewWebsite,
};
