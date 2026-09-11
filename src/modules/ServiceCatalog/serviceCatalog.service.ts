import { prisma } from "../../lib/prisma/prisma";
import {
  IServiceCatalogCreate,
  IServiceCatalogSync,
  IServiceCatalogUpdate,
  IServiceCatalogFilters,
} from "./serviceCatalog.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { IRequestUser } from "../../types/requestUser.interface";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { inferLegacyServiceType } from "../../lib/utils/serviceIdentity";
import { normalizeServiceCategory } from "./serviceCatalog.contract";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import redis from "../../config/redis";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";
import { invalidateBookingFormsForAdmin } from "../BookingForm/bookingForm.cache";
import { ServiceStatus } from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { allocateServiceSlugTx } from "./serviceCatalog.slug";
import { lockServiceCatalogTx } from "./serviceCatalogConcurrency";
import {
  describeRecommendedCleaningServices,
  seedRecommendedCleaningServicesTx,
} from "./recommendedCleaningServices";

const toAddOnsJson = (
  addOns: IServiceCatalogCreate["addOns"] | IServiceCatalogUpdate["addOns"],
): Prisma.InputJsonValue =>
  (addOns ?? []).map((item) => ({ name: item.name, price: item.price }));

const serviceNameKey = (name: string) => name.trim().toLocaleLowerCase("en-GB");

const serviceNameConflictError = (name: string) =>
  new AppError(status.CONFLICT, `A service named "${name}" already exists`, {
    code: "SERVICE_NAME_CONFLICT",
    retryable: false,
    fieldErrors: {
      serviceName: "Service names must be unique for this business.",
    },
  });

const assertActivationReady = (basePrice: number, serviceStatus: ServiceStatus) => {
  if (serviceStatus !== ServiceStatus.ACTIVE) return;
  if (Number.isFinite(basePrice) && basePrice > 0) return;

  throw new AppError(
    status.UNPROCESSABLE_ENTITY,
    "Set a base price greater than 0 before activating this service",
    {
      code: "SERVICE_PRICE_REQUIRED_FOR_ACTIVATION",
      retryable: false,
      fieldErrors: {
        basePrice: "Enter a price greater than 0 before activating this service.",
      },
    },
  );
};

const invalidateServiceCatalogCache = async (adminId: string) => {
  await redis.del(CacheNamespaces.serviceCatalog(adminId)).catch(() => {});
};

const loadCanonicalServiceCatalog = async (adminId: string) => {
  const key = CacheNamespaces.serviceCatalog(adminId);
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof prisma.serviceCatalog.findMany>>;
    } catch {
      void redis.del(key).catch(() => {});
    }
  }

  const services = await prisma.serviceCatalog.findMany({
    where: { adminId, archivedAt: null },
    orderBy: { createdAt: "desc" },
  });
  void redis
    .setex(key, ttlForKey(CacheTtl.serviceCatalog, key), JSON.stringify(services))
    .catch(() => {});
  return services;
};

export const invalidateServiceCatalogReadModels = async (adminId: string) => {
  await Promise.all([
    invalidateServiceCatalogCache(adminId),
    invalidateBookingFormsForAdmin(adminId),
    WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
  ]);
};

const normalizeServiceForApi = <T extends { category: string }>(service: T) => ({
  ...service,
  category: normalizeServiceCategory(service.category),
});

export const syncServiceCatalogSelectionTx = async (
  tx: Prisma.TransactionClient,
  adminId: string,
  payloads: IServiceCatalogSync[],
  options: {
    /** @deprecated Omission is never deletion. */
    authoritativeSelection?: boolean;
    deactivateServiceCatalogIds?: readonly string[];
    requireIdentityForExisting?: boolean;
  } = {},
) => {
  await lockServiceCatalogTx(tx, adminId);
  const normalized = payloads.map(({ addOns, ...payload }) => ({
    ...payload,
    serviceName: payload.serviceName.trim(),
    description: payload.description.trim(),
    duration: payload.duration.trim(),
    category: normalizeServiceCategory(payload.category),
    legacyServiceType:
      payload.legacyServiceType === undefined
        ? inferLegacyServiceType(payload.serviceName)
        : payload.legacyServiceType,
    ...(addOns !== undefined ? { addOns: toAddOnsJson(addOns) } : {}),
  }));

  const seen = new Set<string>();
  const seenIds = new Set<string>();
  for (const item of normalized) {
    const key = serviceNameKey(item.serviceName);
    if (seen.has(key)) {
      throw new AppError(status.BAD_REQUEST, `Duplicate service in setup: ${item.serviceName}`);
    }
    seen.add(key);
    if (item.serviceCatalogId) {
      if (seenIds.has(item.serviceCatalogId)) {
        throw new AppError(
          status.BAD_REQUEST,
          "The same service cannot appear more than once in setup",
          {
            code: "DUPLICATE_SERVICE_CATALOG_ID",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Choose each service only once." },
          },
        );
      }
      seenIds.add(item.serviceCatalogId);
    }
  }

  const existing = await tx.serviceCatalog.findMany({
    where: { adminId, archivedAt: null },
    select: {
      id: true,
      serviceName: true,
      slug: true,
      status: true,
      basePrice: true,
    },
  });
  type ExistingService = (typeof existing)[number];
  const existingById = new Map<string, ExistingService>(
    existing.map((item) => [item.id, item]),
  );
  const existingByName = new Map<string, ExistingService>(
    existing.map((item) => [serviceNameKey(item.serviceName), item]),
  );

  const result = [];
  for (const payload of normalized) {
    const targetNameKey = serviceNameKey(payload.serviceName);
    let current: ExistingService | undefined;

    if (payload.serviceCatalogId) {
      current = existingById.get(payload.serviceCatalogId);
      if (!current) {
        throw new AppError(
          status.UNPROCESSABLE_ENTITY,
          "Selected service is not available for this business",
          {
            code: "SERVICE_CATALOG_ID_INVALID",
            retryable: false,
            fieldErrors: {
              serviceCatalogId: "Choose a service from this business.",
            },
          },
        );
      }
    } else {
      // Backward compatibility for older onboarding clients. New clients always
      // send serviceCatalogId for existing rows, so mutable names are no longer
      // the primary identity for edits/renames.
      current = options.requireIdentityForExisting
        ? undefined
        : existingByName.get(targetNameKey);
    }

    const nameOwner = existingByName.get(targetNameKey);
    if (nameOwner && nameOwner.id !== current?.id) {
      throw serviceNameConflictError(payload.serviceName);
    }

    const intendedStatus = payload.status ?? current?.status ?? ServiceStatus.ACTIVE;
    assertActivationReady(payload.basePrice, intendedStatus);

    const data = {
      serviceName: payload.serviceName,
      description: payload.description,
      basePrice: payload.basePrice,
      duration: payload.duration,
      category: payload.category,
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.onlineBookingEnabled !== undefined
        ? { onlineBookingEnabled: payload.onlineBookingEnabled }
        : {}),
      legacyServiceType: payload.legacyServiceType,
      ...(payload.addOns !== undefined ? { addOns: payload.addOns } : {}),
    };

    if (current) {
      const updated = await tx.serviceCatalog.update({
        where: { id: current.id },
        data,
      });
      result.push(updated);

      // Keep the in-memory uniqueness view aligned for the remainder of this
      // transaction. Slugs intentionally stay stable when a service is renamed,
      // preserving existing public URLs and historical references.
      existingByName.delete(serviceNameKey(current.serviceName));
      const nextCurrent: ExistingService = {
        ...current,
        serviceName: payload.serviceName,
        status: intendedStatus,
        basePrice: payload.basePrice,
      };
      existingByName.set(targetNameKey, nextCurrent);
      existingById.set(current.id, nextCurrent);
    } else {
      const slug = await allocateServiceSlugTx(tx, adminId, payload.serviceName);
      const created = await tx.serviceCatalog.create({
        data: { ...data, adminId, slug },
      });
      result.push(created);
      const nextCurrent: ExistingService = {
        id: created.id,
        serviceName: created.serviceName,
        slug: created.slug,
        status: created.status,
        basePrice: created.basePrice,
      };
      existingByName.set(targetNameKey, nextCurrent);
      existingById.set(created.id, nextCurrent);
    }
  }

  // Explicit removals only. A paginated client (including legacy clients) can
  // never deactivate unseen rows by omitting them from an upsert request.
  const deactivateIds = [...new Set(options.deactivateServiceCatalogIds ?? [])];
  const selectedIds = new Set(result.map((service) => service.id));
  for (const id of deactivateIds) {
    if (!existingById.has(id) || selectedIds.has(id)) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "Invalid service deselection", {
        code: "SERVICE_CATALOG_ID_INVALID",
        retryable: false,
        fieldErrors: {
          deactivateServiceCatalogIds:
            "Use only unselected services belonging to this business.",
        },
      });
    }
  }
  if (deactivateIds.length) {
    await tx.serviceCatalog.updateMany({
      where: {
        adminId,
        archivedAt: null,
        id: { in: deactivateIds },
        status: ServiceStatus.ACTIVE,
      },
      data: { status: ServiceStatus.INACTIVE },
    });
  }

  return result;
};

const createServiceCatalog = async (
  payload: IServiceCatalogCreate,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const serviceName = payload.serviceName.trim();
  const legacyServiceType =
    payload.legacyServiceType === undefined
      ? inferLegacyServiceType(serviceName)
      : payload.legacyServiceType;
  const intendedStatus = payload.status ?? ServiceStatus.ACTIVE;
  assertActivationReady(payload.basePrice, intendedStatus);

  const created = await prisma.$transaction(async (tx) => {
    await lockServiceCatalogTx(tx, adminId);

    const sameName = await tx.serviceCatalog.findFirst({
      where: {
        adminId,
        serviceName: { equals: serviceName, mode: "insensitive" },
      },
    });

    if (sameName && sameName.archivedAt === null) {
      throw serviceNameConflictError(serviceName);
    }

    const data = {
      serviceName,
      description: payload.description.trim(),
      basePrice: payload.basePrice,
      duration: payload.duration.trim(),
      category: normalizeServiceCategory(payload.category),
      status: intendedStatus,
      onlineBookingEnabled: payload.onlineBookingEnabled ?? true,
      legacyServiceType,
      addOns: toAddOnsJson(payload.addOns),
      archivedAt: null,
    };

    // Re-adding a historically referenced service restores the same row rather
    // than creating a duplicate. Its slug/relations remain stable.
    if (sameName?.archivedAt) {
      return tx.serviceCatalog.update({
        where: { id: sameName.id },
        data,
      });
    }

    const slug = await allocateServiceSlugTx(tx, adminId, serviceName);
    return tx.serviceCatalog.create({
      data: { ...data, adminId, slug },
    });
  });

  await invalidateServiceCatalogReadModels(adminId);
  return normalizeServiceForApi(created);
};

const bulkUpsertServiceCatalogs = async (
  payloads: IServiceCatalogCreate[],
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const result = await prisma.$transaction((tx) =>
    syncServiceCatalogSelectionTx(tx, adminId, payloads),
  );
  await invalidateServiceCatalogReadModels(adminId);
  return result.map(normalizeServiceForApi);
};

const getAllServiceCatalogs = async (
  filters: IServiceCatalogFilters,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const { searchTerm, category, status: serviceStatus } = filters;
  const services = await loadCanonicalServiceCatalog(adminId);
  const needle = searchTerm?.trim().toLocaleLowerCase("en-GB") ?? "";

  return services
    .filter((service) => {
      if (category && normalizeServiceCategory(service.category) !== category)
        return false;
      if (
        serviceStatus &&
        String(service.status).toUpperCase() !== String(serviceStatus).toUpperCase()
      )
        return false;
      if (!needle) return true;
      return (
        service.serviceName.toLocaleLowerCase("en-GB").includes(needle) ||
        service.description.toLocaleLowerCase("en-GB").includes(needle)
      );
    })
    .map(normalizeServiceForApi);
};

const getServiceCatalogById = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service =
    (await loadCanonicalServiceCatalog(adminId)).find((item) => item.id === id) ??
    null;
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  return normalizeServiceForApi(service);
};

const updateServiceCatalog = async (
  id: string,
  payload: IServiceCatalogUpdate,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const updated = await prisma.$transaction(async (tx) => {
    await lockServiceCatalogTx(tx, adminId);
    const service = await tx.serviceCatalog.findFirst({
      where: { id, adminId, archivedAt: null },
    });
    if (!service) throw new AppError(status.NOT_FOUND, "Service not found");

    const serviceName = payload.serviceName?.trim();
    if (serviceName && serviceNameKey(serviceName) !== serviceNameKey(service.serviceName)) {
      const nameOwner = await tx.serviceCatalog.findFirst({
        where: {
          adminId,
          id: { not: id },
          serviceName: { equals: serviceName, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (nameOwner) throw serviceNameConflictError(serviceName);
    }

    const resultingStatus = payload.status ?? service.status;
    const resultingPrice = payload.basePrice ?? service.basePrice;
    // Do not strand pre-existing legacy rows that already have a zero price
    // when editing unrelated text. Any new activation or price edit must be
    // valid, however.
    if (payload.status !== undefined || payload.basePrice !== undefined) {
      assertActivationReady(resultingPrice, resultingStatus);
    }

    const legacyServiceType =
      payload.legacyServiceType !== undefined
        ? payload.legacyServiceType
        : serviceName
          ? inferLegacyServiceType(serviceName)
          : undefined;
    const { addOns, ...fields } = payload;
    return tx.serviceCatalog.update({
      where: { id },
      data: {
        ...fields,
        ...(serviceName !== undefined ? { serviceName } : {}),
        ...(payload.description !== undefined
          ? { description: payload.description.trim() }
          : {}),
        ...(payload.duration !== undefined ? { duration: payload.duration.trim() } : {}),
        ...(payload.category !== undefined
          ? { category: normalizeServiceCategory(payload.category) }
          : {}),
        ...(legacyServiceType !== undefined ? { legacyServiceType } : {}),
        ...(addOns !== undefined ? { addOns: toAddOnsJson(addOns) } : {}),
      },
    });
  });

  await invalidateServiceCatalogReadModels(adminId);
  return normalizeServiceForApi(updated);
};

const historicalRelationCountSelect = {
  invoices: true,
  estimates: true,
  quotes: true,
  quoteTemplates: true,
  bookingFormServices: true,
  bookingFormSubmissions: true,
  estimateFormServices: true,
  estimateFormSubmissions: true,
  bookings: true,
  jobs: true,
  recurringSchedules: true,
  checklistTemplates: true,
  leads: true,
  websiteSubmissions: true,
  reviews: true,
} as const;

const deleteServiceCatalog = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const result = await prisma.$transaction(async (tx) => {
    await lockServiceCatalogTx(tx, adminId);

    // Lock the parent row before counting references. PostgreSQL FK writers
    // take a key-share lock on the referenced ServiceCatalog row, so this
    // closes the race where a new booking/invoice could be attached between a
    // zero reference count and the hard delete. A concurrent writer either
    // commits before this lock (and is counted) or waits until deletion ends.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "service_catalog"
      WHERE "id" = ${id}
        AND "adminId" = ${adminId}
        AND "archivedAt" IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new AppError(status.NOT_FOUND, "Service not found");
    }

    const service = await tx.serviceCatalog.findUnique({
      where: { id },
      select: {
        id: true,
        _count: { select: historicalRelationCountSelect },
      },
    });
    if (!service) throw new AppError(status.NOT_FOUND, "Service not found");

    const historicalReferences = Object.values(service._count).reduce(
      (sum, count) => sum + count,
      0,
    );

    if (historicalReferences === 0) {
      await tx.serviceCatalog.delete({ where: { id } });
      return { id, mode: "DELETED" as const, historicalReferences };
    }

    // Referenced services are removed from the live catalogue without severing
    // their identity. Snapshot fields continue to preserve the historical name,
    // price, and duration used by bookings/invoices/reviews.
    await tx.serviceCatalog.update({
      where: { id },
      data: {
        status: ServiceStatus.INACTIVE,
        onlineBookingEnabled: false,
        archivedAt: new Date(),
      },
    });
    return { id, mode: "ARCHIVED" as const, historicalReferences };
  });

  await invalidateServiceCatalogReadModels(adminId);
  return result;
};

const getRecommendedServices = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const existing = await prisma.serviceCatalog.findMany({
    where: { adminId },
    select: { id: true, serviceName: true, slug: true, archivedAt: true },
  });
  return describeRecommendedCleaningServices(existing);
};

const importRecommendedServices = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const result = await prisma.$transaction((tx) =>
    seedRecommendedCleaningServicesTx(tx, adminId),
  );
  await invalidateServiceCatalogReadModels(adminId);
  return result;
};

export const serviceCatalogService = {
  createServiceCatalog,
  bulkUpsertServiceCatalogs,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
  getRecommendedServices,
  importRecommendedServices,
};
