import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { serviceCatalogService } from "./serviceCatalog.service";
import { IServiceCatalogFilters } from "./serviceCatalog.interface";
import { ServiceStatus } from "../../generated/prisma/enums";

const createServiceCatalog = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.createServiceCatalog(
    req.body,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Service created successfully",
    data: result,
  });
});


const bulkUpsertServiceCatalogs = catchAsync(async (req, res) => {
  const result = await serviceCatalogService.bulkUpsertServiceCatalogs(req.body, req.user);
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

  const result = await serviceCatalogService.getAllServiceCatalogs(
    filters,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Services retrieved successfully",
    data: result,
  });
});

const getServiceCatalogById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await serviceCatalogService.getServiceCatalogById(
    id as string,
    req.user,
  );

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

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Service deleted successfully",
    data: result,
  });
});

export const serviceCatalogController = {
  createServiceCatalog,
  bulkUpsertServiceCatalogs,
  getAllServiceCatalogs,
  getServiceCatalogById,
  updateServiceCatalog,
  deleteServiceCatalog,
};
