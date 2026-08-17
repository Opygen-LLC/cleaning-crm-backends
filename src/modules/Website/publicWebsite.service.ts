import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { TemplateRegistry } from "./templateRegistry";
import { buildPublishedSnapshot, parsePublishedSnapshot, selectPublishedIntegrationFormId } from "./websiteSnapshot";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { readyWebsiteDomainWhere } from "./websiteDomainReadiness";
import { buildDefaultWebsiteSeo } from "./websiteSeo";
import { getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";

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

const loadProjectionSource = async (websiteId: string) => {
  const website = await prisma.businessWebsite.findUnique({
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
          serviceCatalogs: {
            where: { status: "ACTIVE" as any },
            select: {
              id: true,
              serviceName: true,
              description: true,
              basePriceGbp: true,
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
            // A website testimonial must satisfy both moderation fields. This
            // fails closed if historical/manual rows ever drift out of sync.
            where: { isPublished: true, status: "published", staffId: null },
            select: {
              id: true,
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
            select: { id: true, city: true, postcode: true },
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
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: {
        where: readyWebsiteDomainWhere as any,
        select: { domain: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!website) throw new AppError(status.NOT_FOUND, "Website not found");

  // Keep the review list bounded for payload size, but calculate the public
  // aggregate across every published tenant review so businesses with >50
  // reviews never display an incorrect rating/count. This is only paid on a
  // website projection cache miss.
  const reviewAggregate = await prisma.review.aggregate({
    where: {
      adminId: website.adminId,
      isPublished: true,
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
  bookingShowHeaderCta: website.bookingShowHeaderCta,
  bookingShowServiceCtas: website.bookingShowServiceCtas,
  bookingShowHomeCta: website.bookingShowHomeCta,
  bookingShowAvailableSlots: website.bookingShowAvailableSlots,
  bookingShowPrices: website.bookingShowPrices,
  estimateEnabled: website.estimateEnabled,
  metaTitle: website.metaTitle,
  metaDescription: website.metaDescription,
  socialImageUrl: website.socialImageUrl,
  indexSite: website.indexSite,
  pages: website.pages,
});

const projectWebsite = (
  source: Awaited<ReturnType<typeof loadProjectionSource>>,
  options: { mode: "public" | "preview"; aliasRedirectSubdomain?: string | null },
) => {
  const { website, reviewSummary } = source;

  if (options.mode === "public") {
    if (website.status === "SUSPENDED" || website.admin.user.status !== "ACTIVE") {
      throw new AppError(status.SERVICE_UNAVAILABLE, "Website temporarily unavailable");
    }
    if (website.status !== "PUBLISHED") throw new AppError(status.NOT_FOUND, "Website not found");
  }

  const snapshot = options.mode === "preview"
    ? currentDraftAsPublishedSnapshot(website)
    : parsePublishedSnapshot(website.publishedSnapshot) ?? currentDraftAsPublishedSnapshot(website);

  const config = snapshot.website;
  const pages = snapshot.pages.filter((page) => page.isEnabled);
  const template = TemplateRegistry.get(config.templateId, config.templateVersion);
  if (!template) throw new AppError(status.SERVICE_UNAVAILABLE, "Website template version is unavailable");

  // Canonical SEO and canonical routing share the exact same primary-domain
  // decision. Phase 17 guarantees that isPrimary is only retained on a
  // routing-ready custom domain (and automatically promotes the first healthy
  // domain), while additional healthy domains remain aliases.
  const primaryDomain = website.domains.find((domain) => domain.isPrimary)?.domain ?? null;
  const canonicalUrl = getCanonicalWebsiteOrigin(website.subdomain, primaryDomain);

  const defaultSeo = buildDefaultWebsiteSeo({
    businessName: website.admin.businessName,
    city: website.admin.city,
    businessDescription: website.admin.businessDescription,
  });

  const selectedBookingForm = config.primaryBookingFormId
    ? website.admin.bookingForms.find((form) => form.id === config.primaryBookingFormId) ?? null
    : null;
  const selectedEstimateForm = config.primaryEstimateFormId
    ? website.admin.estimateForms.find((form) => form.id === config.primaryEstimateFormId) ?? null
    : null;
  const bookingEnabled = config.bookingEnabled && Boolean(selectedBookingForm?.published);
  const estimateEnabled = config.estimateEnabled && Boolean(selectedEstimateForm?.published);

  return {
    website: {
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
        if (page.kind === "BOOK" && (!bookingEnabled || !config.bookingShowHeaderCta)) return false;
        if (page.kind === "ESTIMATE" && !estimateEnabled) return false;
        return true;
      })
      .map((page) => ({ title: page.title, path: page.slug, kind: page.kind })),
    pages: pages.map((page) => ({
      kind: page.kind,
      path: page.slug,
      title: page.title,
      content: page.content,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
    })),
    services: website.admin.serviceCatalogs.map(projectCanonicalService),
    reviews: website.admin.reviews.map((review) => ({
      clientName: review.clientName,
      rating: review.rating,
      comment: review.comment,
      adminReply: review.adminReply,
      createdAt: review.createdAt,
    })),
    reviewSummary,
    serviceAreas: website.admin.workLocations.map((location) => ({
      city: location.city,
      postcode: location.postcode,
    })),
    bookingPreferences: {
      enabled: config.bookingEnabled,
      showHeaderCta: config.bookingShowHeaderCta,
      showServiceCtas: config.bookingShowServiceCtas,
      showHomeCta: config.bookingShowHomeCta,
      showAvailableSlots: config.bookingShowAvailableSlots,
      showPrices: config.bookingShowPrices,
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
      socialImageUrl: config.socialImageUrl,
      indexSite: options.mode === "preview" ? false : config.indexSite,
      canonicalUrl,
    },
  };
};

const getPublicWebsiteById = async (websiteId: string, aliasRedirectSubdomain: string | null = null) => {
  type PublicProjection = ReturnType<typeof projectWebsite>;
  const canonical = await WebsiteProjectionCacheService.getOrLoad<PublicProjection>(
    websiteId,
    async () => {
      const website = await loadProjectionSource(websiteId);
      return projectWebsite(website, { mode: "public", aliasRedirectSubdomain: null });
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


const loadPublishedIntegrationSource = async (identifier: string) => {
  const resolved = await resolveIdentifier(identifier);
  const website = await prisma.businessWebsite.findUnique({
    where: { id: resolved.websiteId },
    select: {
      id: true,
      adminId: true,
      status: true,
      publishedSnapshot: true,
      primaryBookingFormId: true,
      primaryEstimateFormId: true,
      estimateEnabled: true,
      bookingEnabled: true,
      bookingShowAvailableSlots: true,
      bookingShowPrices: true,
      subdomain: true,
      pages: { select: { kind: true, isEnabled: true } },
      admin: { select: { businessName: true, user: { select: { status: true } } } },
    },
  });

  if (!website) throw new AppError(status.NOT_FOUND, "Website not found");
  if (website.status === "SUSPENDED" || website.admin.user.status !== "ACTIVE") {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website temporarily unavailable");
  }
  if (website.status !== "PUBLISHED") {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }

  return website;
};

const resolvePublicBookingIntegration = async (identifier: string) => {
  const website = await loadPublishedIntegrationSource(identifier);

  const publishedSnapshot = parsePublishedSnapshot(website.publishedSnapshot);
  const formId = selectPublishedIntegrationFormId(publishedSnapshot, website.primaryBookingFormId, "booking");
  const bookingEnabled = publishedSnapshot
    ? publishedSnapshot.website.bookingEnabled
    : website.bookingEnabled;
  const showAvailableSlots = publishedSnapshot
    ? publishedSnapshot.website.bookingShowAvailableSlots
    : website.bookingShowAvailableSlots;
  const showPrices = publishedSnapshot
    ? publishedSnapshot.website.bookingShowPrices
    : website.bookingShowPrices;
  const bookPageEnabled = publishedSnapshot
    ? publishedSnapshot.pages.some((page) => page.kind === "BOOK" && page.isEnabled)
    : website.pages.some((page) => page.kind === "BOOK" && page.isEnabled);

  if (!bookingEnabled || !formId || !bookPageEnabled) {
    throw new AppError(status.NOT_FOUND, "Online booking is not available on this website.", {
      code: "WEBSITE_BOOKING_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: website.id,
    adminId: website.adminId,
    formId,
    showAvailableSlots,
    showPrices,
  };
};

const resolvePublicEstimateIntegration = async (identifier: string) => {
  const website = await loadPublishedIntegrationSource(identifier);
  const publishedSnapshot = parsePublishedSnapshot(website.publishedSnapshot);
  const formId = selectPublishedIntegrationFormId(publishedSnapshot, website.primaryEstimateFormId, "estimate");
  const estimateEnabled = publishedSnapshot
    ? publishedSnapshot.website.estimateEnabled
    : website.estimateEnabled;
  const estimatePageEnabled = publishedSnapshot
    ? publishedSnapshot.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled)
    : website.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled);

  if (!estimateEnabled || !formId || !estimatePageEnabled) {
    throw new AppError(status.NOT_FOUND, "Online estimates are not available on this website.", {
      code: "WEBSITE_ESTIMATE_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: website.id,
    adminId: website.adminId,
    formId,
  };
};

const resolvePublicContactIntegration = async (identifier: string) => {
  const website = await loadPublishedIntegrationSource(identifier);
  const publishedSnapshot = parsePublishedSnapshot(website.publishedSnapshot);
  const contactPageEnabled = publishedSnapshot
    ? publishedSnapshot.pages.some((page) => page.kind === "CONTACT" && page.isEnabled)
    : website.pages.some((page) => page.kind === "CONTACT" && page.isEnabled);

  if (!contactPageEnabled) {
    throw new AppError(status.NOT_FOUND, "Contact is not available on this website.", {
      code: "WEBSITE_CONTACT_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: website.id,
    adminId: website.adminId,
    subdomain: website.subdomain,
    businessName: website.admin.businessName,
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

export const PublicWebsiteService = {
  resolveIdentifier,
  getPublicWebsiteById,
  getPublicWebsite,
  resolvePublicBookingIntegration,
  resolvePublicEstimateIntegration,
  resolvePublicContactIntegration,
  getPreviewWebsite,
};
