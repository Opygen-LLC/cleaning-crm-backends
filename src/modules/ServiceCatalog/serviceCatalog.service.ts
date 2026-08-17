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
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
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
        basePriceGbp: payload.basePriceGbp,
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

  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
  return result;
};

const getAllServiceCatalogs = async (
  filters: IServiceCatalogFilters,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const { searchTerm, category, status: serviceStatus } = filters;
  const andConditions: any[] = [{ adminId }];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { serviceName: { contains: searchTerm, mode: "insensitive" } },
        { description: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }
  if (category) andConditions.push({ category });
  if (serviceStatus) andConditions.push({ status: String(serviceStatus).toUpperCase() });

  return prisma.serviceCatalog.findMany({
    where: { AND: andConditions },
    orderBy: { createdAt: "desc" },
  });
};

const getServiceCatalogById = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
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
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
  return updated;
};

const deleteServiceCatalog = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  const deleted = await prisma.serviceCatalog.delete({ where: { id } });
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
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
