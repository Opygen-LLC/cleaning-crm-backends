import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { superAdminService } from "./superAdmin.service";
import {
  IActivityLogFilters,
  IAdminAccountFilters,
} from "./superAdmin.interface";

// ─── Platform Stats ───────────────────────────────────────────────────────────

const getPlatformStats = catchAsync(async (req, res) => {
  const result = await superAdminService.getPlatformStats();
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Platform stats retrieved successfully",
    data: result,
  });
});

// ─── Revenue ──────────────────────────────────────────────────────────────────

const getPlatformRevenueDashboard = catchAsync(async (req, res) => {
  const result = await superAdminService.getPlatformRevenueDashboard({
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
    interval: req.query.interval as "daily" | "weekly" | "monthly",
  });
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Platform revenue dashboard retrieved successfully",
    data: result,
  });
});

// ─── Activity Logs ────────────────────────────────────────────────────────────

const getActivityLogs = catchAsync(async (req, res) => {
  const filters: IActivityLogFilters = {
    searchTerm: req.query.searchTerm as string,
    action: req.query.action as string,
    entityType: req.query.entityType as string,
    adminId: req.query.adminId as string,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
  };
  const paginationOptions = {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  };

  const result = await superAdminService.getActivityLogs(
    filters,
    paginationOptions,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Activity logs retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getActivityLogStats = catchAsync(async (req, res) => {
  const result = await superAdminService.getActivityLogStats();
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Activity log stats retrieved successfully",
    data: result,
  });
});

// ─── Admin Accounts ───────────────────────────────────────────────────────────

const getAllAdminAccounts = catchAsync(async (req, res) => {
  const filters: IAdminAccountFilters = {
    searchTerm: req.query.searchTerm as string,
    status: req.query.status as string,
    subscriptionStatus: req.query.subscriptionStatus as string,
  };
  const paginationOptions = {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  };

  const result = await superAdminService.getAllAdminAccounts(
    filters,
    paginationOptions,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin accounts retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getAdminAccountById = catchAsync(async (req, res) => {
  const result = await superAdminService.getAdminAccountById(req.params.adminId as string);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin account retrieved successfully",
    data: result,
  });
});

const suspendAdminAccount = catchAsync(async (req, res) => {
  const result = await superAdminService.suspendAdminAccount(req.params.adminId as string);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin account suspended successfully",
    data: result,
  });
});

const activateAdminAccount = catchAsync(async (req, res) => {
  const result = await superAdminService.activateAdminAccount(req.params.adminId as string);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin account activated successfully",
    data: result,
  });
});

// ─── Subscription Plan CRUD ───────────────────────────────────────────────────

const createSubscriptionPlan = catchAsync(async (req, res) => {
  const result = await superAdminService.createSubscriptionPlan(req.body);
  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Subscription plan created successfully",
    data: result,
  });
});

const updateSubscriptionPlan = catchAsync(async (req, res) => {
  const result = await superAdminService.updateSubscriptionPlan(
    req.params.planId as string,
    req.body,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription plan updated successfully",
    data: result,
  });
});

const updatePricingTier = catchAsync(async (req, res) => {
  const result = await superAdminService.updatePricingTier(
    req.params.tierId as string,
    req.body,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Pricing tier updated successfully",
    data: result,
  });
});

const deleteSubscriptionPlan = catchAsync(async (req, res) => {
  const result = await superAdminService.deleteSubscriptionPlan(req.params.planId as string);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription plan deleted successfully",
    data: result,
  });
});

// ─── Subscription Management ──────────────────────────────────────────────────

const getAllSubscriptions = catchAsync(async (req, res) => {
  const filters = {
    status: req.query.status as string,
    planId: req.query.planId as string,
    isTrial: req.query.isTrial as string,
  };
  const paginationOptions = {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  };

  const result = await superAdminService.getAllSubscriptions(
    filters,
    paginationOptions,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscriptions retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const cancelSubscription = catchAsync(async (req, res) => {
  const result = await superAdminService.cancelSubscription(
    req.params.subscriptionId as string,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription cancelled successfully",
    data: result,
  });
});

const getBillingHistory = catchAsync(async (req, res) => {
  const filters = {
    adminId: req.query.adminId as string,
    subscriptionId: req.query.subscriptionId as string,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
  };
  const paginationOptions = {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  };

  const result = await superAdminService.getBillingHistory(
    filters,
    paginationOptions,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Billing history retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const superAdminController = {
  getPlatformStats,
  getPlatformRevenueDashboard,
  getActivityLogs,
  getActivityLogStats,
  getAllAdminAccounts,
  getAdminAccountById,
  suspendAdminAccount,
  activateAdminAccount,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  updatePricingTier,
  deleteSubscriptionPlan,
  getAllSubscriptions,
  cancelSubscription,
  getBillingHistory,
};
