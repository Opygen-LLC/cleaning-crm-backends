import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { serviceCatalogService } from "./serviceCatalog.service";
import { IServiceCatalogFilters } from "./serviceCatalog.interface";
import { ServiceStatus } from "../../generated/prisma/enums";
import {
  bumpCacheResourcesForUser,
  CacheResource,
} from "../../lib/cache/resourceCacheVersion";

const catalogCacheResources = [CacheResource.services, CacheResource.dashboard];

const createServiceCatalog = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.createServiceCatalog(req.body, req.user);
  await bumpCacheResourcesForUser(req.user, catalogCacheResources);

  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Service created successfully",
    data: result,
  });
});

const bulkUpsertServiceCatalogs = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.bulkUpsertServiceCatalogs(req.body, req.user);
  await bumpCacheResourcesForUser(req.user, catalogCacheResources);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Services saved successfully",
    data: result,
  });
});

const getAllServiceCatalogs = catchAsync(async (req, res) => {
  const filters: IServiceCatalogFilters = {
    searchTerm: req.query.searchTerm as string,
    category: req.query.category as IServiceCatalogFilters["category"],
    status: req.query.status as ServiceStatus,
  };

  const result = await serviceCatalogService.getAllServiceCatalogs(filters, req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Services retrieved successfully",
    data: result,
  });
});

const getRecommendedServices = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.getRecommendedServices(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recommended cleaning services retrieved successfully",
    data: result,
  });
});

const importRecommendedServices = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.importRecommendedServices(req.user);
  await bumpCacheResourcesForUser(req.user, catalogCacheResources);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message:
      result.createdCount + result.restoredCount > 0
        ? "Recommended cleaning services added successfully"
        : "All recommended cleaning services are already installed",
    data: result,
  });
});

const getServiceCatalogById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await serviceCatalogService.getServiceCatalogById(id as string, req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Service retrieved successfully",
    data: result,
  });
});

const updateServiceCatalog = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await serviceCatalogService.updateServiceCatalog(
    id as string,
    req.body,
    req.user,
  );
  await bumpCacheResourcesForUser(req.user, catalogCacheResources);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Service updated successfully",
    data: result,
  });
});

const deleteServiceCatalog = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await serviceCatalogService.deleteServiceCatalog(id as string, req.user);
  await bumpCacheResourcesForUser(req.user, catalogCacheResources);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message:
      result.mode === "ARCHIVED"
        ? "Service removed from the current catalogue; historical records were preserved"
        : "Service deleted successfully",
    data: result,
  });
});

export const serviceCatalogController = {
  createServiceCatalog,
  bulkUpsertServiceCatalogs,
  getAllServiceCatalogs,
  getRecommendedServices,
  importRecommendedServices,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
