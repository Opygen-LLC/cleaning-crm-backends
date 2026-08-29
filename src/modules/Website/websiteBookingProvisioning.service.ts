import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { FormFieldType, ServiceCategory, ServiceStatus, ServiceType } from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { statusAfterDraftMutation, WEBSITE_STATUS, type WebsiteLifecycleStatus } from "./websiteLifecycle";
import { parsePublishedSnapshot } from "./websiteSnapshot";

export interface WebsiteBookingSetupPayload {
  enabled: boolean;
  bookingFormId?: string | null;
  showNavigation?: boolean;
  showHeaderCta?: boolean;
  showServiceCtas?: boolean;
  showHomeCta?: boolean;
  showAvailableSlots?: boolean;
  showPrices?: boolean;
  showStartingPrices?: boolean;
  showServiceDuration?: boolean;
  ctaLabel?: string;
}

export interface WebsiteBookingSetupFormOption {
  id: string;
  headline: string;
  slug: string;
  published: true;
  websiteManaged: boolean;
}

export interface WebsiteBookingSetupResult {
  enabled: boolean;
  live: boolean;
  primaryBookingFormId: string | null;
  primaryBookingForm: WebsiteBookingSetupFormOption | null;
  publishedForms: WebsiteBookingSetupFormOption[];
  publishedFormCount: number;
  bookableServiceCount: number;
  requiresSelection: boolean;
  canCreateDefault: boolean;
  websitePath: "/book";
  estimate: {
    enabled: boolean;
    live: boolean;
    primaryEstimateFormId: string | null;
    primaryEstimateForm: { id: string; headline: string; slug: string; published: true } | null;
    publishedForms: Array<{ id: string; headline: string; slug: string; published: true }>;
    websitePath: "/estimate";
  };
  settings: {
    showNavigation: boolean;
    showHeaderCta: boolean;
    showServiceCtas: boolean;
    showHomeCta: boolean;
    showAvailableSlots: boolean;
    showPrices: boolean;
    showStartingPrices: boolean;
    showServiceDuration: boolean;
    ctaLabel: string;
  };
}

const DEFAULT_AVAILABLE_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DEFAULT_TIME_SLOTS = [
  "Monday|09:00-17:00",
  "Tuesday|09:00-17:00",
  "Wednesday|09:00-17:00",
  "Thursday|09:00-17:00",
  "Friday|09:00-15:00",
];

const DEFAULT_FIELDS = [
  {
    type: FormFieldType.TEXT,
    label: "Full name",
    placeholder: "Jane Smith",
    required: true,
    enabled: true,
    options: [] as string[],
    sortOrder: 0,
  },
  {
    type: FormFieldType.EMAIL,
    label: "Email address",
    placeholder: "jane@example.com",
    required: true,
    enabled: true,
    options: [] as string[],
    sortOrder: 1,
  },
  {
    type: FormFieldType.PHONE,
    label: "Phone number",
    placeholder: "+44 7700 900000",
    required: true,
    enabled: true,
    options: [] as string[],
    sortOrder: 2,
  },
  {
    type: FormFieldType.ADDRESS,
    label: "Service address",
    placeholder: "123 High Street",
    required: true,
    enabled: true,
    options: [] as string[],
    sortOrder: 3,
  },
  {
    type: FormFieldType.TEXTAREA,
    label: "Special requests",
    placeholder: "Anything we should know before the clean?",
    required: false,
    enabled: true,
    options: [] as string[],
    sortOrder: 4,
  },
];

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "cleaning-business";

const generatedBookingSlug = (businessName: string, adminId: string): string =>
  `${slugify(businessName)}-online-booking-${adminId.replace(/-/g, "")}`;

const formOptionSelect = {
  id: true,
  headline: true,
  slug: true,
  published: true,
  websiteManaged: true,
} as const;

const estimateFormOptionSelect = {
  id: true,
  headline: true,
  slug: true,
  published: true,
} as const;

type BookingSetupQueryRow = {
  status: WebsiteLifecycleStatus;
  publishedSnapshot: Prisma.JsonValue | null;
  primaryBookingFormId: string | null;
  bookingEnabled: boolean;
  bookingShowNavigation: boolean;
  bookingShowHeaderCta: boolean;
  bookingShowServiceCtas: boolean;
  bookingShowHomeCta: boolean;
  bookingShowAvailableSlots: boolean;
  bookingShowPrices: boolean;
  bookingShowStartingPrices: boolean;
  bookingShowServiceDuration: boolean;
  bookingCtaLabel: string;
  primaryEstimateFormId: string | null;
  estimateEnabled: boolean;
  primaryBookingForm: WebsiteBookingSetupFormOption | null;
  primaryEstimateForm: { id: string; headline: string; slug: string; published: true } | null;
  publishedForms: WebsiteBookingSetupFormOption[];
  publishedEstimateForms: Array<{ id: string; headline: string; slug: string; published: true }>;
  bookableServiceCount: bigint | number;
};

/**
 * Booking Studio bootstrap is intentionally one SQL round-trip. The previous
 * implementation issued four independent Prisma reads after every mutation,
 * which made the endpoint especially sensitive to cross-region DB latency.
 */
const getSetupByAdminId = async (adminId: string): Promise<WebsiteBookingSetupResult> => {
  const rows = await prisma.$queryRaw<BookingSetupQueryRow[]>`
    SELECT
      bw."status"::text AS "status",
      bw."publishedSnapshot" AS "publishedSnapshot",
      bw."primaryBookingFormId" AS "primaryBookingFormId",
      bw."bookingEnabled" AS "bookingEnabled",
      bw."bookingShowNavigation" AS "bookingShowNavigation",
      bw."bookingShowHeaderCta" AS "bookingShowHeaderCta",
      bw."bookingShowServiceCtas" AS "bookingShowServiceCtas",
      bw."bookingShowHomeCta" AS "bookingShowHomeCta",
      bw."bookingShowAvailableSlots" AS "bookingShowAvailableSlots",
      bw."bookingShowPrices" AS "bookingShowPrices",
      bw."bookingShowStartingPrices" AS "bookingShowStartingPrices",
      bw."bookingShowServiceDuration" AS "bookingShowServiceDuration",
      bw."bookingCtaLabel" AS "bookingCtaLabel",
      bw."primaryEstimateFormId" AS "primaryEstimateFormId",
      bw."estimateEnabled" AS "estimateEnabled",
      CASE WHEN primary_booking.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', primary_booking.id,
        'headline', primary_booking.headline,
        'slug', primary_booking.slug,
        'published', primary_booking.published,
        'websiteManaged', primary_booking."websiteManaged"
      ) END AS "primaryBookingForm",
      CASE WHEN primary_estimate.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', primary_estimate.id,
        'headline', primary_estimate.headline,
        'slug', primary_estimate.slug,
        'published', primary_estimate.published
      ) END AS "primaryEstimateForm",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', bf.id,
          'headline', bf.headline,
          'slug', bf.slug,
          'published', true,
          'websiteManaged', bf."websiteManaged"
        ) ORDER BY bf."updatedAt" DESC, bf."createdAt" DESC)
        FROM "booking_form" bf
        WHERE bf."adminId" = bw."adminId" AND bf.published = true
      ), '[]'::jsonb) AS "publishedForms",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', ef.id,
          'headline', ef.headline,
          'slug', ef.slug,
          'published', true
        ) ORDER BY ef."updatedAt" DESC, ef."createdAt" DESC)
        FROM (
          SELECT id, headline, slug, published, "updatedAt", "createdAt"
          FROM "estimate_form"
          WHERE "adminId" = bw."adminId" AND published = true
          ORDER BY "updatedAt" DESC, "createdAt" DESC
          LIMIT 100
        ) ef
      ), '[]'::jsonb) AS "publishedEstimateForms",
      (
        SELECT COUNT(*)
        FROM "service_catalog" sc
        WHERE sc."adminId" = bw."adminId"
          AND sc.status = 'ACTIVE'::"ServiceStatus"
          AND sc."onlineBookingEnabled" = true
      ) AS "bookableServiceCount"
    FROM "business_website" bw
    LEFT JOIN "booking_form" primary_booking ON primary_booking.id = bw."primaryBookingFormId"
    LEFT JOIN "estimate_form" primary_estimate ON primary_estimate.id = bw."primaryEstimateFormId"
    WHERE bw."adminId" = ${adminId}
    LIMIT 1
  `;

  const website = rows[0];
  if (!website) {
    throw new AppError(status.NOT_FOUND, "Business website not found", {
      code: "WEBSITE_NOT_FOUND",
      retryable: false,
    });
  }

  const primary = website.primaryBookingForm?.published ? website.primaryBookingForm : null;
  const primaryEstimate = website.primaryEstimateForm?.published ? website.primaryEstimateForm : null;
  const published = parsePublishedSnapshot(website.publishedSnapshot);
  const bookingLive = Boolean(
    website.status === WEBSITE_STATUS.PUBLISHED &&
      published?.website.bookingEnabled &&
      published.website.primaryBookingFormId &&
      published.pages.some((page) => page.kind === "BOOK" && page.isEnabled),
  );
  const estimateLive = Boolean(
    website.status === WEBSITE_STATUS.PUBLISHED &&
      published?.website.estimateEnabled &&
      published.website.primaryEstimateFormId &&
      published.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled),
  );

  return {
    enabled: website.bookingEnabled,
    live: bookingLive,
    primaryBookingFormId: website.primaryBookingFormId,
    primaryBookingForm: primary,
    publishedForms: website.publishedForms,
    publishedFormCount: website.publishedForms.length,
    bookableServiceCount: Number(website.bookableServiceCount),
    requiresSelection: website.bookingEnabled && !primary && website.publishedForms.length > 1,
    canCreateDefault: website.publishedForms.length === 0,
    websitePath: "/book",
    estimate: {
      enabled: website.estimateEnabled,
      live: estimateLive,
      primaryEstimateFormId: website.primaryEstimateFormId,
      primaryEstimateForm: primaryEstimate,
      publishedForms: website.publishedEstimateForms,
      websitePath: "/estimate",
    },
    settings: {
      showNavigation: website.bookingShowNavigation,
      showHeaderCta: website.bookingShowHeaderCta,
      showServiceCtas: website.bookingShowServiceCtas,
      showHomeCta: website.bookingShowHomeCta,
      showAvailableSlots: website.bookingShowAvailableSlots,
      showPrices: website.bookingShowPrices,
      showStartingPrices: website.bookingShowStartingPrices,
      showServiceDuration: website.bookingShowServiceDuration,
      ctaLabel: website.bookingCtaLabel,
    },
  };
};

const getSetup = async (user: IRequestUser): Promise<WebsiteBookingSetupResult> => {
  const adminId = await getAdminId(user);
  return getSetupByAdminId(adminId);
};

const ensureAtLeastOneBookableService = async (tx: Prisma.TransactionClient, adminId: string) => {
  let services = await tx.serviceCatalog.findMany({
    where: {
      adminId,
      status: ServiceStatus.ACTIVE,
      onlineBookingEnabled: true,
    },
    select: {
      id: true,
      duration: true,
      legacyServiceType: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (services.length > 0) return services;

  const activeServiceCount = await tx.serviceCatalog.count({
    where: { adminId, status: ServiceStatus.ACTIVE },
  });

  // "Skip setup & use defaults" may be used before the Services step. In that
  // one case, create a single canonical ServiceCatalog record so the website
  // still gets a working booking route. If the owner already has services but
  // explicitly disabled online booking for all of them, respect that choice.
  if (activeServiceCount === 0) {
    const created = await tx.serviceCatalog.create({
      data: {
        adminId,
        serviceName: "Standard Cleaning",
        description: "Routine home cleaning for kitchens, bathrooms, bedrooms and living areas.",
        basePrice: 60,
        duration: "2h",
        category: ServiceCategory.RESIDENTIAL,
        status: ServiceStatus.ACTIVE,
        onlineBookingEnabled: true,
        legacyServiceType: ServiceType.RESIDENTIAL_CLEAN,
        addOns: [],
      },
      select: {
        id: true,
        duration: true,
        legacyServiceType: true,
      },
    });
    services = [created];
  }

  if (services.length === 0) {
    throw new AppError(status.CONFLICT, "Enable online booking for at least one service before connecting website booking.", {
      code: "NO_BOOKABLE_SERVICES",
      retryable: false,
      fieldErrors: {
        services: "Turn on Online booking for at least one active service.",
      },
    });
  }

  return services;
};

const syncManagedFormServices = async (
  tx: Prisma.TransactionClient,
  formId: string,
  services: Array<{ id: string; duration: string; legacyServiceType: ServiceType | null }>,
) => {
  const existing = await tx.bookingFormService.findMany({
    where: { formId },
    select: { serviceCatalogId: true, serviceType: true, duration: true, enabled: true },
  });
  const expected = new Map(
    services.map((service) => [
      service.id,
      { serviceType: service.legacyServiceType ?? null, duration: service.duration, enabled: true },
    ]),
  );
  const alreadySynchronized =
    existing.length === expected.size &&
    existing.every((row) => {
      if (!row.serviceCatalogId) return false;
      const target = expected.get(row.serviceCatalogId);
      return Boolean(
        target &&
          row.enabled === target.enabled &&
          row.duration === target.duration &&
          row.serviceType === target.serviceType,
      );
    });
  if (alreadySynchronized) return;

  await tx.bookingFormService.deleteMany({ where: { formId } });
  if (services.length > 0) {
    await tx.bookingFormService.createMany({
      data: services.map((service) => ({
        formId,
        serviceCatalogId: service.id,
        serviceType: service.legacyServiceType ?? null,
        enabled: true,
        duration: service.duration,
      })),
    });
  }
};

const createManagedBookingForm = async (
  tx: Prisma.TransactionClient,
  admin: { id: string; businessName: string },
  website: { accentColor: string },
  services: Array<{ id: string; duration: string; legacyServiceType: ServiceType | null }>,
) => {
  const form = await tx.bookingForm.create({
    data: {
      adminId: admin.id,
      slug: generatedBookingSlug(admin.businessName, admin.id),
      published: true,
      websiteManaged: true,
      headline: `${admin.businessName} Online Booking`,
      subheading: "Choose a service, add any extras, and reserve an available cleaning time.",
      accentColor: website.accentColor,
      showReviews: true,
      ctaLabel: "Book Now",
      confirmationMessage: "Thanks — your booking is confirmed. Keep your booking reference for any changes.",
      availableDays: DEFAULT_AVAILABLE_DAYS,
      blockedDates: [],
      timeSlots: DEFAULT_TIME_SLOTS,
      maxBookingsPerSlot: 1,
      slotDurationMinutes: 120,
      bufferTimeMinutes: 0,
      fields: { createMany: { data: DEFAULT_FIELDS } },
    },
    select: formOptionSelect,
  });

  if (services.length > 0) {
    await tx.bookingFormService.createMany({
      data: services.map((service) => ({
        formId: form.id,
        serviceCatalogId: service.id,
        serviceType: service.legacyServiceType ?? null,
        enabled: true,
        duration: service.duration,
      })),
    });
  }
  return { ...form, servicesSynchronized: true as const };
};

const selectOrCreateBookingFormTx = async (
  tx: Prisma.TransactionClient,
  admin: {
    id: string;
    businessName: string;
    businessWebsite: {
      id: string;
      status: string;
      accentColor: string;
      primaryBookingFormId: string | null;
    };
  },
  requestedBookingFormId?: string | null,
) => {
  const adminId = admin.id;
  const services = await ensureAtLeastOneBookableService(tx, adminId);
  let targetForm: { id: string; websiteManaged: boolean } | null = null;
  let servicesSynchronized = false;

  if (requestedBookingFormId) {
    targetForm = await tx.bookingForm.findFirst({
      where: { id: requestedBookingFormId, adminId, published: true },
      select: { id: true, websiteManaged: true },
    });

    if (!targetForm) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "Choose a published booking form owned by this business", {
        code: "BOOKING_FORM_INVALID",
        retryable: false,
        fieldErrors: { bookingFormId: "Choose one of your published booking forms." },
      });
    }
  } else if (admin.businessWebsite.primaryBookingFormId) {
    const currentPrimary = await tx.bookingForm.findFirst({
      where: { id: admin.businessWebsite.primaryBookingFormId, adminId },
      select: { id: true, published: true, websiteManaged: true },
    });

    if (currentPrimary?.published) {
      targetForm = currentPrimary;
    } else if (currentPrimary?.websiteManaged) {
      await tx.bookingForm.update({
        where: { id: currentPrimary.id },
        data: { published: true },
      });
      targetForm = { id: currentPrimary.id, websiteManaged: true };
    }
  }

  if (!targetForm) {
    const publishedForms = await tx.bookingForm.findMany({
      where: { adminId, published: true },
      select: { id: true, websiteManaged: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 2,
    });

    if (publishedForms.length === 1) {
      targetForm = publishedForms[0];
    } else if (publishedForms.length > 1) {
      throw new AppError(status.CONFLICT, "Choose which published booking form should power your website.", {
        code: "BOOKING_FORM_SELECTION_REQUIRED",
        retryable: false,
        fieldErrors: { bookingFormId: "Select a published booking form to continue." },
      });
    }
  }

  if (!targetForm) {
    // Reuse a previously generated form that an owner later unpublished. This
    // keeps launch/configuration retries idempotent and preserves one managed
    // website form per tenant.
    const reusableManaged = await tx.bookingForm.findFirst({
      where: { adminId, websiteManaged: true },
      select: { id: true, websiteManaged: true },
      orderBy: { createdAt: "asc" },
    });

    if (reusableManaged) {
      await tx.bookingForm.update({
        where: { id: reusableManaged.id },
        data: { published: true },
      });
      targetForm = reusableManaged;
    } else {
      const created = await createManagedBookingForm(tx, admin, admin.businessWebsite, services);
      targetForm = created;
      servicesSynchronized = created.servicesSynchronized;
    }
  }

  if (!targetForm) {
    // Defensive invariant: every successful path above must select, reuse or
    // create exactly one BookingForm. Keep the return type non-null and fail
    // closed if a provider/database mock ever violates that contract.
    throw new AppError(status.INTERNAL_SERVER_ERROR, "Unable to provision website booking", {
      code: "WEBSITE_BOOKING_PROVISION_FAILED",
      retryable: true,
    });
  }

  if (targetForm.websiteManaged && !servicesSynchronized) {
    // Auto-created forms mirror ServiceCatalog online-booking eligibility.
    // Manually authored forms remain owner-controlled and are never rewritten.
    await syncManagedFormServices(tx, targetForm.id, services);
  }

  return targetForm;
};

/**
 * Transaction-level primitive used by the first website launch. It shares the
 * same selection/creation rules as the onboarding booking screen, but never
 * opens a nested transaction and therefore participates in the website launch
 * commit atomically.
 */
type LaunchBookingAdminContext = {
  id: string;
  businessName: string;
  businessWebsite: {
    id: string;
    status: string;
    accentColor: string;
    primaryBookingFormId: string | null;
    bookingEnabled: boolean;
  };
};

const ensureAttachedForLaunchTx = async (
  tx: Prisma.TransactionClient,
  adminId: string,
  websiteId: string,
  launchContext?: LaunchBookingAdminContext,
): Promise<string> => {
  await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${adminId}`);

  // Website launch already loaded and locked this tenant's draft. Reuse that
  // authoritative context instead of re-reading AdminProfile + Website. Other
  // callers can omit it and retain the defensive lookup.
  const admin = launchContext ?? await tx.adminProfile.findUnique({
    where: { id: adminId },
    select: {
      id: true,
      businessName: true,
      businessWebsite: {
        select: {
          id: true,
          status: true,
          accentColor: true,
          primaryBookingFormId: true,
          bookingEnabled: true,
        },
      },
    },
  });

  if (!admin?.businessWebsite || admin.businessWebsite.id !== websiteId || admin.id !== adminId) {
    throw new AppError(status.NOT_FOUND, "Business website not found", {
      code: "WEBSITE_NOT_FOUND",
      retryable: false,
    });
  }
  if (admin.businessWebsite.status === WEBSITE_STATUS.SUSPENDED) {
    throw new AppError(status.CONFLICT, "Suspended websites cannot be launched", {
      code: "WEBSITE_SUSPENDED",
      retryable: false,
    });
  }

  const bookingAdmin = {
    id: admin.id,
    businessName: admin.businessName,
    businessWebsite: {
      id: admin.businessWebsite.id,
      status: admin.businessWebsite.status,
      accentColor: admin.businessWebsite.accentColor,
      primaryBookingFormId: admin.businessWebsite.primaryBookingFormId,
    },
  };
  const targetForm = await selectOrCreateBookingFormTx(tx, bookingAdmin, null);
  if (targetForm.id !== admin.businessWebsite.primaryBookingFormId) {
    await tx.businessWebsite.update({
      where: { id: websiteId },
      data: { primaryBookingFormId: targetForm.id },
    });
  }
  return targetForm.id;
};

export const configureForAdminTx = async (
  tx: Prisma.TransactionClient,
  adminId: string,
  payload: WebsiteBookingSetupPayload,
): Promise<{ websiteId: string; primaryBookingFormId: string | null }> => {
  const admin = await tx.adminProfile.findUnique({
    where: { id: adminId },
    select: {
      id: true,
      businessName: true,
      businessWebsite: {
        select: {
          id: true,
          status: true,
          accentColor: true,
          primaryBookingFormId: true,
        },
      },
    },
  });

  const businessWebsite = admin?.businessWebsite;
  if (!admin || !businessWebsite) {
    throw new AppError(status.NOT_FOUND, "Business website not found", {
      code: "WEBSITE_NOT_FOUND",
      retryable: false,
    });
  }

  if (businessWebsite.status === WEBSITE_STATUS.SUSPENDED) {
    throw new AppError(status.CONFLICT, "Suspended websites cannot change booking configuration", {
      code: "WEBSITE_SUSPENDED",
      retryable: false,
    });
  }

  const nextWebsiteStatus = statusAfterDraftMutation(businessWebsite.status as WebsiteLifecycleStatus);
  const presentationPatch = {
    ...(payload.showNavigation !== undefined ? { bookingShowNavigation: payload.showNavigation } : {}),
    ...(payload.showHeaderCta !== undefined ? { bookingShowHeaderCta: payload.showHeaderCta } : {}),
    ...(payload.showServiceCtas !== undefined ? { bookingShowServiceCtas: payload.showServiceCtas } : {}),
    ...(payload.showHomeCta !== undefined ? { bookingShowHomeCta: payload.showHomeCta } : {}),
    ...(payload.showAvailableSlots !== undefined ? { bookingShowAvailableSlots: payload.showAvailableSlots } : {}),
    ...(payload.showPrices !== undefined ? { bookingShowPrices: payload.showPrices } : {}),
    ...(payload.showStartingPrices !== undefined ? { bookingShowStartingPrices: payload.showStartingPrices } : {}),
    ...(payload.showServiceDuration !== undefined ? { bookingShowServiceDuration: payload.showServiceDuration } : {}),
    ...(payload.ctaLabel !== undefined ? { bookingCtaLabel: payload.ctaLabel.trim() || "Book Now" } : {}),
  };

  if (!payload.enabled) {
    await Promise.all([
      tx.businessWebsite.update({
        where: { id: businessWebsite.id },
        data: { bookingEnabled: false, status: nextWebsiteStatus, ...presentationPatch },
      }),
      tx.websitePage.updateMany({
        where: { websiteId: businessWebsite.id, kind: "BOOK" },
        data: { isEnabled: false, showInNavigation: false },
      }),
    ]);
    return { websiteId: businessWebsite.id, primaryBookingFormId: businessWebsite.primaryBookingFormId };
  }

  const targetForm = await selectOrCreateBookingFormTx(
    tx,
    { id: admin.id, businessName: admin.businessName, businessWebsite },
    payload.bookingFormId,
  );
  await Promise.all([
    tx.businessWebsite.update({
      where: { id: businessWebsite.id },
      data: {
        primaryBookingFormId: targetForm.id,
        bookingEnabled: true,
        status: nextWebsiteStatus,
        ...presentationPatch,
      },
    }),
    tx.websitePage.updateMany({
      where: { websiteId: businessWebsite.id, kind: "BOOK" },
      data: { isEnabled: true, showInNavigation: true },
    }),
  ]);
  return { websiteId: businessWebsite.id, primaryBookingFormId: targetForm.id };
};

const configure = async (
  payload: WebsiteBookingSetupPayload,
  user: IRequestUser,
): Promise<WebsiteBookingSetupResult> => {
  const adminId = await getAdminId(user);
  await prisma.$transaction(async (tx) => {
    await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${adminId}`);
    await configureForAdminTx(tx, adminId, payload);
  });
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
  return getSetupByAdminId(adminId);
};

export const WebsiteBookingProvisioningService = {
  getSetup,
  getSetupByAdminId,
  configure,
  configureForAdminTx,
  ensureAttachedForLaunchTx,
};
