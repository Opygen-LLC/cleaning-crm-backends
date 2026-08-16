import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { normalizeDomain } from "./websiteIdentity";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { TemplateRegistry } from "./templateRegistry";
import { buildPublishedSnapshot, parsePublishedSnapshot } from "./websiteSnapshot";

interface ResolvedWebsite {
  websiteId: string;
  aliasRedirectSubdomain: string | null;
}

const resolveIdentifier = async (identifier: string): Promise<ResolvedWebsite> => {
  const raw = identifier.trim();
  if (!raw) throw new AppError(status.NOT_FOUND, "Website not found");

  // Domain identifiers remain supported for direct API callers. Edge host
  // routing uses WebsiteHostResolverService; only VERIFIED domain rows may
  // resolve to public website data.
  if (raw.includes(".")) {
    let domain: string;
    try {
      domain = normalizeDomain(raw);
    } catch {
      throw new AppError(status.NOT_FOUND, "Website not found");
    }
    const record = await prisma.websiteDomain.findFirst({
      where: { domain, status: "VERIFIED" as any },
      select: { websiteId: true },
    });
    if (!record) throw new AppError(status.NOT_FOUND, "Website not found");
    return { websiteId: record.websiteId, aliasRedirectSubdomain: null };
  }

  const resolved = await WebsiteHostResolverService.resolveSubdomain(raw);
  return {
    websiteId: resolved.websiteId,
    aliasRedirectSubdomain: resolved.isAlias ? resolved.canonicalSubdomain : null,
  };
};

const getReviewSummary = (reviews: Array<{ rating: number }>) => {
  if (reviews.length === 0) return { averageRating: null, count: 0 };
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return {
    averageRating: Math.round((total / reviews.length) * 10) / 10,
    count: reviews.length,
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
          address: true,
          city: true,
          zipcode: true,
          country: true,
          brandColor: true,
          user: { select: { email: true, status: true } },
          serviceCatalogs: {
            where: { status: "ACTIVE" as any },
            orderBy: [{ category: "asc" }, { serviceName: "asc" }],
          },
          reviews: {
            where: { isPublished: true, staffId: null },
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
          // Keep form resolution inside the same tenant-scoped query. The
          // published snapshot may point to a different form than the current
          // draft, so reading only BusinessWebsite.primary* relations would
          // make draft changes leak into (or break) the published runtime.
          bookingForms: {
            select: { id: true, slug: true, published: true, headline: true, subheading: true },
          },
          estimateForms: {
            select: { id: true, slug: true, published: true, headline: true, subheading: true },
          },
        },
      },
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: {
        where: { status: "VERIFIED" as any },
        select: { domain: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Website not found");
  return website;
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
  metaTitle: website.metaTitle,
  metaDescription: website.metaDescription,
  socialImageUrl: website.socialImageUrl,
  indexSite: website.indexSite,
  pages: website.pages,
});

const projectWebsite = (
  website: Awaited<ReturnType<typeof loadProjectionSource>>,
  options: { mode: "public" | "preview"; aliasRedirectSubdomain?: string | null },
) => {
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

  // Only an explicitly selected verified custom domain becomes canonical.
  // Merely connecting/verifying an additional hostname must not change SEO or
  // redirect behavior until the owner intentionally makes it primary.
  const primaryDomain = website.domains.find((domain) => domain.isPrimary)?.domain ?? null;
  const canonicalUrl = primaryDomain
    ? `https://${primaryDomain}`
    : WEBSITE_BASE_DOMAIN
      ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}`
      : null;

  const selectedBookingForm = config.primaryBookingFormId
    ? website.admin.bookingForms.find((form) => form.id === config.primaryBookingFormId) ?? null
    : null;
  const selectedEstimateForm = config.primaryEstimateFormId
    ? website.admin.estimateForms.find((form) => form.id === config.primaryEstimateFormId) ?? null
    : null;
  const bookingEnabled = Boolean(selectedBookingForm?.published);
  const estimateEnabled = Boolean(selectedEstimateForm?.published);
  const reviewSummary = getReviewSummary(website.admin.reviews);

  return {
    website: {
      subdomain: website.subdomain,
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
        if (page.kind === "BOOK" && !bookingEnabled) return false;
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
      title: config.metaTitle ?? website.admin.businessName,
      description: config.metaDescription,
      socialImageUrl: config.socialImageUrl ?? config.logo ?? website.admin.businessLogo ?? null,
      indexSite: options.mode === "preview" ? false : config.indexSite,
      canonicalUrl,
    },
  };
};

const getPublicWebsiteById = async (websiteId: string, aliasRedirectSubdomain: string | null = null) => {
  const website = await loadProjectionSource(websiteId);
  return projectWebsite(website, { mode: "public", aliasRedirectSubdomain });
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
      subdomain: true,
      pages: { select: { kind: true, isEnabled: true } },
      admin: { select: { user: { select: { status: true } } } },
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
  const formId = publishedSnapshot?.website.primaryBookingFormId ?? website.primaryBookingFormId;
  const bookPageEnabled = publishedSnapshot
    ? publishedSnapshot.pages.some((page) => page.kind === "BOOK" && page.isEnabled)
    : website.pages.some((page) => page.kind === "BOOK" && page.isEnabled);

  if (!formId || !bookPageEnabled) {
    throw new AppError(status.NOT_FOUND, "Online booking is not available on this website.", {
      code: "WEBSITE_BOOKING_UNAVAILABLE",
      retryable: false,
    });
  }

  return {
    websiteId: website.id,
    adminId: website.adminId,
    formId,
  };
};

const resolvePublicEstimateIntegration = async (identifier: string) => {
  const website = await loadPublishedIntegrationSource(identifier);
  const publishedSnapshot = parsePublishedSnapshot(website.publishedSnapshot);
  const formId = publishedSnapshot?.website.primaryEstimateFormId ?? website.primaryEstimateFormId;
  const estimatePageEnabled = publishedSnapshot
    ? publishedSnapshot.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled)
    : website.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled);

  if (!formId || !estimatePageEnabled) {
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
  };
};

const getPreviewWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  const source = await loadProjectionSource(website.id);
  if (source.admin.user.status !== "ACTIVE") {
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
