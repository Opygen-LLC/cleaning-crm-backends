import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { FormFieldType, ServiceStatus, ServiceType } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { statusAfterDraftMutation, WEBSITE_STATUS, type WebsiteLifecycleStatus } from "./websiteLifecycle";

export interface WebsiteBookingSetupPayload {
  enabled: boolean;
  bookingFormId?: string | null;
  showHeaderCta?: boolean;
  showServiceCtas?: boolean;
  showHomeCta?: boolean;
  showAvailableSlots?: boolean;
  showPrices?: boolean;
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
  primaryBookingFormId: string | null;
  primaryBookingForm: WebsiteBookingSetupFormOption | null;
  publishedForms: WebsiteBookingSetupFormOption[];
  publishedFormCount: number;
  bookableServiceCount: number;
  requiresSelection: boolean;
  canCreateDefault: boolean;
  websitePath: "/book";
  settings: {
    showHeaderCta: boolean;
    showServiceCtas: boolean;
    showHomeCta: boolean;
    showAvailableSlots: boolean;
    showPrices: boolean;
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

const getSetupByAdminId = async (adminId: string): Promise<WebsiteBookingSetupResult> => {
  const [website, publishedForms, bookableServiceCount] = await Promise.all([
    prisma.businessWebsite.findUnique({
      where: { adminId },
      select: {
        primaryBookingFormId: true,
        bookingEnabled: true,
        bookingShowHeaderCta: true,
        bookingShowServiceCtas: true,
        bookingShowHomeCta: true,
        bookingShowAvailableSlots: true,
        bookingShowPrices: true,
        primaryBookingForm: { select: formOptionSelect },
      },
    }),
    prisma.bookingForm.findMany({
      where: { adminId, published: true },
      select: formOptionSelect,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.serviceCatalog.count({
      where: {
        adminId,
        status: ServiceStatus.ACTIVE,
        onlineBookingEnabled: true,
      },
    }),
  ]);

  if (!website) {
    throw new AppError(status.NOT_FOUND, "Business website not found", {
      code: "WEBSITE_NOT_FOUND",
      retryable: false,
    });
  }

  const primary = website.primaryBookingForm?.published
    ? ({ ...website.primaryBookingForm, published: true } as WebsiteBookingSetupFormOption)
    : null;
  const options = publishedForms.map((form) => ({
    ...form,
    published: true as const,
  }));

  return {
    enabled: website.bookingEnabled,
    primaryBookingFormId: website.primaryBookingFormId,
    primaryBookingForm: primary,
    publishedForms: options,
    publishedFormCount: options.length,
    bookableServiceCount,
    requiresSelection: website.bookingEnabled && !primary && options.length > 1,
    canCreateDefault: options.length === 0,
    websitePath: "/book",
    settings: {
      showHeaderCta: website.bookingShowHeaderCta,
      showServiceCtas: website.bookingShowServiceCtas,
      showHomeCta: website.bookingShowHomeCta,
      showAvailableSlots: website.bookingShowAvailableSlots,
      showPrices: website.bookingShowPrices,
    },
  };
};

const getSetup = async (user: IRequestUser): Promise<WebsiteBookingSetupResult> => {
  const adminId = await getAdminId(user);
  return getSetupByAdminId(adminId);
};

const ensureAtLeastOneBookableService = async (tx: any, adminId: string) => {
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
        basePriceGbp: 60,
        duration: "2h",
        category: "Residential",
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

const syncManagedFormServices = async (tx: any, formId: string, services: Array<{ id: string; duration: string; legacyServiceType: unknown }>) => {
  await tx.bookingFormService.deleteMany({ where: { formId } });
  await tx.bookingFormService.createMany({
    data: services.map((service) => ({
      formId,
      serviceCatalogId: service.id,
      serviceType: service.legacyServiceType ?? null,
      enabled: true,
      duration: service.duration,
    })),
  });
};

const createManagedBookingForm = async (
  tx: any,
  admin: { id: string; businessName: string },
  website: { accentColor: string },
  services: Array<{ id: string; duration: string; legacyServiceType: unknown }>,
) => {
  const form = await tx.bookingForm.create({
    data: {
      adminId: admin.id,
      slug: generatedBookingSlug(admin.businessName, admin.id),
      published: true,
      websiteManaged: true,
      headline: `${admin.businessName} Online Booking`,
      subheading: "Choose a service, select an available time, and send your booking request.",
      accentColor: website.accentColor,
      showReviews: true,
      ctaLabel: "Book now",
      confirmationMessage: "Thanks — your booking request has been received.",
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

  await syncManagedFormServices(tx, form.id, services);
  return form;
};

const selectOrCreateBookingFormTx = async (
  tx: any,
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
      targetForm = await createManagedBookingForm(tx, admin, admin.businessWebsite, services);
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

  if (targetForm.websiteManaged) {
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
const ensureAttachedForLaunchTx = async (
  tx: any,
  adminId: string,
  websiteId: string,
): Promise<string> => {
  await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${adminId}`);

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
          bookingEnabled: true,
        },
      },
    },
  });

  if (!admin?.businessWebsite || admin.businessWebsite.id !== websiteId) {
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

  const targetForm = await selectOrCreateBookingFormTx(tx, admin, null);
  if (targetForm.id !== admin.businessWebsite.primaryBookingFormId) {
    await tx.businessWebsite.update({
      where: { id: websiteId },
      data: { primaryBookingFormId: targetForm.id },
    });
  }
  return targetForm.id;
};

const configure = async (
  payload: WebsiteBookingSetupPayload,
  user: IRequestUser,
): Promise<WebsiteBookingSetupResult> => {
  const adminId = await getAdminId(user);

  await prisma.$transaction(async (tx) => {
    await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${adminId}`);

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
      ...(payload.showHeaderCta !== undefined ? { bookingShowHeaderCta: payload.showHeaderCta } : {}),
      ...(payload.showServiceCtas !== undefined ? { bookingShowServiceCtas: payload.showServiceCtas } : {}),
      ...(payload.showHomeCta !== undefined ? { bookingShowHomeCta: payload.showHomeCta } : {}),
      ...(payload.showAvailableSlots !== undefined ? { bookingShowAvailableSlots: payload.showAvailableSlots } : {}),
      ...(payload.showPrices !== undefined ? { bookingShowPrices: payload.showPrices } : {}),
    };

    if (!payload.enabled) {
      await tx.businessWebsite.update({
        where: { id: businessWebsite.id },
        data: { bookingEnabled: false, status: nextWebsiteStatus, ...presentationPatch },
      });
      return;
    }

    const targetForm = await selectOrCreateBookingFormTx(
      tx,
      { id: admin.id, businessName: admin.businessName, businessWebsite },
      payload.bookingFormId,
    );
    await tx.businessWebsite.update({
      where: { id: businessWebsite.id },
      data: {
        primaryBookingFormId: targetForm.id,
        bookingEnabled: true,
        status: nextWebsiteStatus,
        ...presentationPatch,
      },
    });
  });

  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
  return getSetupByAdminId(adminId);
};

export const WebsiteBookingProvisioningService = {
  getSetup,
  configure,
  ensureAttachedForLaunchTx,
};
