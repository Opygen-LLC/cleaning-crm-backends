import { prisma } from "../../lib/prisma/prisma";
import { WEBSITE_CUSTOM_DOMAINS_ENABLED } from "../../config/ENV";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteService } from "./website.service";
import { parsePublishedSnapshot } from "./websiteSnapshot";

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

  const [website, business, bookingForms, estimateForms] = await Promise.all([
    WebsiteService.getWebsiteForAdmin(adminId),
    prisma.adminProfile.findUnique({
      where: { id: adminId },
      select: {
        businessName: true,
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

  return {
    website,
    business: {
      name: business?.businessName?.trim() || "Your cleaning business",
    },
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
    templates: TemplateRegistry.list(),
    bookingForms,
    estimateForms,
    features: {
      customDomainsEnabled: WEBSITE_CUSTOM_DOMAINS_ENABLED,
    },
  };
};

export const WebsiteStudioService = { getStudio };
