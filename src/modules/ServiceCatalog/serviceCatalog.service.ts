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
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import redis from "../../config/redis";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";
import { invalidateBookingFormsForAdmin } from "../BookingForm/bookingForm.cache";


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

const invalidateServiceCatalogReadModels = async (adminId: string) => {
  await Promise.all([
    invalidateServiceCatalogCache(adminId),
    invalidateBookingFormsForAdmin(adminId),
    WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
  ]);
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
  return created;
};


const bulkUpsertServiceCatalogs = async (
  payloads: IServiceCatalogCreate[],
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const normalized = payloads.map((payload) => ({
    ...payload,
    serviceName: payload.serviceName.trim(),
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

  // PostgreSQL's default unique comparison is case-sensitive. Resolve existing
  // services case-insensitively first so a resumed setup cannot accidentally
  // create both "Standard Cleaning" and "standard cleaning" for one tenant.
  const existing = await prisma.serviceCatalog.findMany({
    where: { adminId },
    select: { id: true, serviceName: true },
  });
  const existingByName = new Map(
    existing.map((item) => [item.serviceName.toLocaleLowerCase("en-GB"), item]),
  );

  const result = await prisma.$transaction(async (tx) =>
    Promise.all(normalized.map((payload) => {
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

      return current
        ? tx.serviceCatalog.update({ where: { id: current.id }, data })
        : tx.serviceCatalog.create({ data: { ...data, adminId } });
    })),
  );

  await invalidateServiceCatalogReadModels(adminId);
  return result;
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
    if (category && service.category !== category) return false;
    if (serviceStatus && String(service.status).toUpperCase() !== String(serviceStatus).toUpperCase()) return false;
    if (!needle) return true;
    return (
      service.serviceName.toLocaleLowerCase("en-GB").includes(needle) ||
      service.description.toLocaleLowerCase("en-GB").includes(needle)
    );
  });
};

const getServiceCatalogById = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = (await loadCanonicalServiceCatalog(adminId)).find((item) => item.id === id) ?? null;
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  return service;
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
  return updated;
};

const deleteServiceCatalog = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  const deleted = await prisma.serviceCatalog.delete({ where: { id } });
  await invalidateServiceCatalogReadModels(adminId);
  return deleted;
};

export const serviceCatalogService = {
  createServiceCatalog,
  bulkUpsertServiceCatalogs,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
