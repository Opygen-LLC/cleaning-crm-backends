import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";
import { normalizeDomain, normalizeSubdomain } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";

interface ResolvedWebsite {
  websiteId: string;
  aliasRedirectSubdomain: string | null;
}

const resolveIdentifier = async (identifier: string): Promise<ResolvedWebsite> => {
  const raw = identifier.trim();
  if (!raw) throw new AppError(status.NOT_FOUND, "Website not found");

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

  let subdomain: string;
  try {
    subdomain = normalizeSubdomain(raw);
  } catch {
    throw new AppError(status.NOT_FOUND, "Website not found");
  }
  const website = await prisma.businessWebsite.findUnique({
    where: { subdomain },
    select: { id: true },
  });
  if (website) return { websiteId: website.id, aliasRedirectSubdomain: null };

  const alias = await prisma.websiteSubdomainAlias.findUnique({
    where: { subdomain },
    select: { websiteId: true, website: { select: { subdomain: true } } },
  });
  if (!alias) throw new AppError(status.NOT_FOUND, "Website not found");
  return { websiteId: alias.websiteId, aliasRedirectSubdomain: alias.website.subdomain };
};

const getReviewSummary = (reviews: Array<{ rating: number }>) => {
  if (reviews.length === 0) return { averageRating: null, count: 0 };
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return {
    averageRating: Math.round((total / reviews.length) * 10) / 10,
    count: reviews.length,
  };
};

const getPublicWebsiteById = async (websiteId: string, aliasRedirectSubdomain: string | null = null) => {
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
        },
      },
      pages: {
        where: { isEnabled: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      domains: {
        where: { status: "VERIFIED" as any },
        select: { domain: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
      primaryBookingForm: {
        select: { id: true, adminId: true, slug: true, published: true, headline: true, subheading: true },
      },
      primaryEstimateForm: {
        select: { id: true, adminId: true, slug: true, published: true, headline: true, subheading: true },
      },
    },
  });

  if (!website) throw new AppError(status.NOT_FOUND, "Website not found");
  if (website.status === "SUSPENDED" || website.admin.user.status !== "ACTIVE") {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website temporarily unavailable");
  }
  if (website.status !== "PUBLISHED") throw new AppError(status.NOT_FOUND, "Website not found");

  const template = TemplateRegistry.get(website.templateId, website.templateVersion);
  if (!template) throw new AppError(status.SERVICE_UNAVAILABLE, "Website template version is unavailable");

  const primaryDomain = website.domains.find((domain) => domain.isPrimary)?.domain ?? website.domains[0]?.domain ?? null;
  const canonicalUrl = primaryDomain
    ? `https://${primaryDomain}`
    : WEBSITE_BASE_DOMAIN
      ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}`
      : null;
  // WebsiteService already validates ownership when forms are linked. Keep a
  // defense-in-depth check here as well so malformed/manual database state can
  // never expose another tenant's public form through this website.
  const bookingEnabled = Boolean(
    website.primaryBookingForm?.published && website.primaryBookingForm.adminId === website.admin.id,
  );
  const estimateEnabled = Boolean(
    website.primaryEstimateForm?.published && website.primaryEstimateForm.adminId === website.admin.id,
  );
  const reviewSummary = getReviewSummary(website.admin.reviews);

  return {
    website: {
      subdomain: website.subdomain,
      status: website.status,
      template: {
        id: template.id,
        version: template.version,
        schemaVersion: website.schemaVersion,
        name: template.name,
        capabilities: template.capabilities,
      },
      canonicalUrl,
      redirectToSubdomain: aliasRedirectSubdomain,
    },
    business: projectPublicBusiness(website.admin),
    theme: {
      primaryColor: website.primaryColor,
      secondaryColor: website.secondaryColor,
      accentColor: website.accentColor,
      font: website.font,
      logo: website.logo ?? website.admin.businessLogo ?? null,
      favicon: website.favicon,
    },
    navigation: website.pages
      .filter((page) => {
        if (!page.showInNavigation) return false;
        if (page.kind === "BOOK" && !bookingEnabled) return false;
        if (page.kind === "ESTIMATE" && !estimateEnabled) return false;
        return true;
      })
      .map((page) => ({ title: page.title, path: page.slug, kind: page.kind })),
    pages: website.pages.map((page) => ({
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
    booking: bookingEnabled && website.primaryBookingForm
      ? {
          formId: website.primaryBookingForm.id,
          legacySlug: website.primaryBookingForm.slug,
          headline: website.primaryBookingForm.headline,
          subheading: website.primaryBookingForm.subheading,
          path: "/book",
        }
      : null,
    estimate: estimateEnabled && website.primaryEstimateForm
      ? {
          formId: website.primaryEstimateForm.id,
          legacySlug: website.primaryEstimateForm.slug,
          headline: website.primaryEstimateForm.headline,
          subheading: website.primaryEstimateForm.subheading,
          path: "/estimate",
        }
      : null,
    seo: {
      title: website.metaTitle ?? website.admin.businessName,
      description: website.metaDescription,
      socialImageUrl: website.socialImageUrl ?? website.logo ?? website.admin.businessLogo ?? null,
      indexSite: website.indexSite,
      canonicalUrl,
    },
  };
};

const getPublicWebsite = async (identifier: string) => {
  const resolved = await resolveIdentifier(identifier);
  return getPublicWebsiteById(resolved.websiteId, resolved.aliasRedirectSubdomain);
};

export const PublicWebsiteService = { resolveIdentifier, getPublicWebsiteById, getPublicWebsite };
