import { prisma } from "../../lib/prisma/prisma";
import {
  IServiceCatalogCreate,
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
    where: { adminId },
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
  tx: any,
  adminId: string,
  payloads: IServiceCatalogCreate[],
  options: { authoritativeSelection?: boolean } = {},
) => {
  const normalized = payloads.map((payload) => ({
    ...payload,
    serviceName: payload.serviceName.trim(),
    description: payload.description.trim(),
    duration: payload.duration.trim(),
    category: normalizeServiceCategory(payload.category),
    legacyServiceType: payload.legacyServiceType === undefined
      ? inferLegacyServiceType(payload.serviceName)
      : payload.legacyServiceType,
    addOns: payload.addOns ? (payload.addOns as any) : [],
  }));

  const seen = new Set<string>();
  for (const item of normalized) {
    const key = item.serviceName.toLocaleLowerCase("en-GB");
    if (seen.has(key)) {
      throw new AppError(status.BAD_REQUEST, `Duplicate service in setup: ${item.serviceName}`);
    }
    seen.add(key);
  }

  const existing = await tx.serviceCatalog.findMany({
    where: { adminId },
    select: { id: true, serviceName: true },
  });
  const existingByName = new Map(
    existing.map((item: { id: string; serviceName: string }) => [
      item.serviceName.toLocaleLowerCase("en-GB"),
      item,
    ]),
  );

  const result = [];
  for (const payload of normalized) {
    const current = existingByName.get(payload.serviceName.toLocaleLowerCase("en-GB"));
    const data = {
      serviceName: payload.serviceName,
      description: payload.description,
      basePrice: payload.basePrice,
      duration: payload.duration,
      category: payload.category,
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      onlineBookingEnabled: payload.onlineBookingEnabled ?? true,
      legacyServiceType: payload.legacyServiceType,
      addOns: payload.addOns,
    };
    result.push(current
      ? await tx.serviceCatalog.update({ where: { id: current.id }, data })
      : await tx.serviceCatalog.create({ data: { ...data, adminId } }));
  }

  // The onboarding command sends the complete selected set, so omitted active
  // catalog entries must become inactive. This makes deselection durable while
  // preserving historical records referenced by bookings/invoices. Other bulk
  // callers keep the legacy non-destructive upsert behavior by default.
  if (options.authoritativeSelection) {
    const selectedIds = result.map((service: { id: string }) => service.id);
    await tx.serviceCatalog.updateMany({
      where: {
        adminId,
        status: ServiceStatus.ACTIVE,
        ...(selectedIds.length > 0 ? { id: { notIn: selectedIds } } : {}),
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
  const legacyServiceType = payload.legacyServiceType === undefined
    ? inferLegacyServiceType(payload.serviceName)
    : payload.legacyServiceType;

  const created = await prisma.serviceCatalog.create({
    data: {
      ...payload,
      adminId,
      legacyServiceType,
      addOns: payload.addOns ? (payload.addOns as any) : [],
    },
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

  return services.filter((service) => {
    if (category && normalizeServiceCategory(service.category) !== category) return false;
    if (serviceStatus && String(service.status).toUpperCase() !== String(serviceStatus).toUpperCase()) return false;
    if (!needle) return true;
    return (
      service.serviceName.toLocaleLowerCase("en-GB").includes(needle) ||
      service.description.toLocaleLowerCase("en-GB").includes(needle)
    );
  }).map(normalizeServiceForApi);
};

const getServiceCatalogById = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = (await loadCanonicalServiceCatalog(adminId)).find((item) => item.id === id) ?? null;
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  return normalizeServiceForApi(service);
};

const updateServiceCatalog = async (
  id: string,
  payload: IServiceCatalogUpdate,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");

  const legacyServiceType = payload.legacyServiceType !== undefined
    ? payload.legacyServiceType
    : payload.serviceName
      ? inferLegacyServiceType(payload.serviceName)
      : undefined;

  const updated = await prisma.serviceCatalog.update({
    where: { id },
    data: {
      ...payload,
      ...(legacyServiceType !== undefined ? { legacyServiceType } : {}),
      addOns: payload.addOns ? (payload.addOns as any) : undefined,
    },
  });
  await invalidateServiceCatalogReadModels(adminId);
  return normalizeServiceForApi(updated);
};

const deleteServiceCatalog = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  const deleted = await prisma.serviceCatalog.delete({ where: { id } });
  await invalidateServiceCatalogReadModels(adminId);
  return normalizeServiceForApi(deleted);
};

export const serviceCatalogService = {
  createServiceCatalog,
  bulkUpsertServiceCatalogs,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
