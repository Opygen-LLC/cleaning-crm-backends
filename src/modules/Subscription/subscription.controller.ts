import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { subscriptionService } from "./subscription.service";

const getMySubscription = catchAsync(async (req, res) => {
  const result = await subscriptionService.getMySubscription(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "My subscription retrieved successfully",
    data: result,
  });
});

const changePlan = catchAsync(async (req, res) => {
  const result = await subscriptionService.changePlan(req.user, req.body);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription plan changed successfully",
    data: result,
  });
});

const cancelAtPeriodEnd = catchAsync(async (req, res) => {
  const result = await subscriptionService.cancelAtPeriodEnd(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription will be cancelled at the end of the billing period",
    data: result,
  });
});

const resumeSubscription = catchAsync(async (req, res) => {
  const result = await subscriptionService.resumeSubscription(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription cancellation reversed successfully",
    data: result,
  });
});

const getMyBillingHistory = catchAsync(async (req, res) => {
  const result = await subscriptionService.getMyBillingHistory(req.user, {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  });
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Billing history retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

export const subscriptionController = {
  getMySubscription,
  changePlan,
  cancelAtPeriodEnd,
  resumeSubscription,
  getMyBillingHistory,
};
