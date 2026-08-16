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

const createServiceCatalog = async (
  payload: IServiceCatalogCreate,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const legacyServiceType = payload.legacyServiceType === undefined
    ? inferLegacyServiceType(payload.serviceName)
    : payload.legacyServiceType;

  return prisma.serviceCatalog.create({
    data: {
      ...payload,
      adminId,
      legacyServiceType,
      addOns: payload.addOns ? (payload.addOns as any) : [],
    },
  });
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

  return prisma.serviceCatalog.update({
    where: { id },
    data: {
      ...payload,
      ...(legacyServiceType !== undefined ? { legacyServiceType } : {}),
      addOns: payload.addOns ? (payload.addOns as any) : undefined,
    },
  });
};

const deleteServiceCatalog = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const service = await prisma.serviceCatalog.findFirst({ where: { id, adminId } });
  if (!service) throw new AppError(status.NOT_FOUND, "Service not found");
  return prisma.serviceCatalog.delete({ where: { id } });
};

export const serviceCatalogService = {
  createServiceCatalog,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
