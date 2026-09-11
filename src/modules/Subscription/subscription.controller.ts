import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { subscriptionService } from "./subscription.service";

const getMySubscription = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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
    message: "Plan checkout created. Your current subscription stays unchanged until payment is approved.",
    data: result,
  });
});


const cancelPendingPlanChange = catchAsync(async (req, res) => {
  const result = await subscriptionService.cancelPendingPlanChange(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Pending plan change cancelled",
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
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Billing history retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const initiateSubscriptionProofUpload = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const result = await subscriptionService.initiateSubscriptionProofUpload(req.user, {
    filename: req.body.filename,
    contentType: req.body.contentType,
    size: req.body.size,
  });
  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Subscription proof upload session created",
    data: result,
  });
});

const finalizeSubscriptionProofUpload = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const result = await subscriptionService.finalizeSubscriptionProofUpload(
    req.user,
    req.params.uploadId as string,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Subscription proof upload finalized",
    data: result,
  });
});

const submitPaymentProof = catchAsync(async (req, res) => {
  const result = await subscriptionService.submitPaymentProof(req.user!, {
    paymentProofAssetId: req.body.paymentProofAssetId,
    amount:          req.body.amount,
    method:          req.body.method,
    note:            req.body.note,
    transactionId:   req.body.transactionId,
  });

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Payment proof submitted for review. Your current access remains unchanged until approval.",
    data: result,
  });
});

export const subscriptionController = {
  getMySubscription,
  changePlan,
  cancelPendingPlanChange,
  cancelAtPeriodEnd,
  resumeSubscription,
  getMyBillingHistory,
  initiateSubscriptionProofUpload,
  finalizeSubscriptionProofUpload,
  submitPaymentProof
};
