import { prisma } from "../../lib/prisma/prisma";
import {
  IServiceCatalogCreate,
  IServiceCatalogUpdate,
  IServiceCatalogFilters,
} from "./serviceCatalog.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { UserRole } from "../../generated/prisma/enums";

const createServiceCatalog = async (
  payload: IServiceCatalogCreate,
  user: any,
) => {
  const adminProfile = await prisma.adminProfile.findUnique({
    where: { userId: user.id },
  });

  if (!adminProfile) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  return await prisma.serviceCatalog.create({
    data: {
      ...payload,
      adminId: adminProfile.id,
      addOns: payload.addOns ? (payload.addOns as any) : [],
    },
  });
};

const getAllServiceCatalogs = async (
  filters: IServiceCatalogFilters,
  user: any,
) => {
  const { searchTerm, category, status: serviceStatus, adminId } = filters;
  const andConditions: any[] = [];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { serviceName: { contains: searchTerm, mode: "insensitive" } },
        { description: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }

  if (category) {
    andConditions.push({ category });
  }

  if (serviceStatus) {
    // Handle case-insensitivity for status (e.g., "active" -> "ACTIVE")
    const statusValue = (serviceStatus as string).toUpperCase();
    andConditions.push({ status: statusValue as any });
  }

  // Filter by adminId if provided or restrict by user role
  if (adminId) {
    andConditions.push({ adminId });
  } else if (user.role === UserRole.ADMIN) {
    const adminProfile = await prisma.adminProfile.findUnique({
      where: { userId: user.id },
    });
    if (adminProfile) {
      andConditions.push({ adminId: adminProfile.id });
    }
  }

  const whereConditions =
    andConditions.length > 0 ? { AND: andConditions } : {};

  return await prisma.serviceCatalog.findMany({
    where: whereConditions,
    orderBy: {
      createdAt: "desc",
    },
  });
};

const getServiceCatalogById = async (id: string) => {
  const service = await prisma.serviceCatalog.findUnique({
    where: { id },
  });

  if (!service) {
    throw new AppError(status.NOT_FOUND, "Service not found");
  }

  return service;
};

const updateServiceCatalog = async (
  id: string,
  payload: IServiceCatalogUpdate,
) => {
  const service = await prisma.serviceCatalog.findUnique({ where: { id } });

  if (!service) {
    throw new AppError(status.NOT_FOUND, "Service not found");
  }

  return await prisma.serviceCatalog.update({
    where: { id },
    data: {
      ...payload,
      addOns: payload.addOns ? (payload.addOns as any) : undefined,
    },
  });
};

const deleteServiceCatalog = async (id: string) => {
  const service = await prisma.serviceCatalog.findUnique({ where: { id } });

  if (!service) {
    throw new AppError(status.NOT_FOUND, "Service not found");
  }

  return await prisma.serviceCatalog.delete({
    where: { id },
  });
};

export const serviceCatalogService = {
  createServiceCatalog,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
