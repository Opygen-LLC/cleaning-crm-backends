import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { paymentGatewayService } from "./paymentGateway.service";

const getConfig = catchAsync(async (req, res) => {
  const result = await paymentGatewayService.getPaymentGatewayConfig(
    req.user.id,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Payment gateway config fetched successfully",
    data: result,
  });
});

const updateConfig = catchAsync(async (req, res) => {
  const result = await paymentGatewayService.updatePaymentGatewayConfig(
    req.user.id,
    req.body,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Payment gateway config updated successfully",
    data: result,
  });
});

// FIX: Added controller for POST /payment-gateway/oauth
const oauthConnect = catchAsync(async (req, res) => {
  const { gateway, code } = req.body as { gateway: "stripe" | "paypal"; code: string };
  const result = await paymentGatewayService.oauthConnect(req.user.id, gateway, code);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: `${gateway} connected successfully`,
    data: result,
  });
});

// FIX: Added controller for POST /payment-gateway/disconnect
const disconnectGateway = catchAsync(async (req, res) => {
  const { gateway } = req.body as { gateway: "stripe" | "paypal" };
  const result = await paymentGatewayService.disconnectGateway(req.user.id, gateway);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: `${gateway} disconnected successfully`,
    data: result,
  });
});

// PayPal sends webhook events to POST /payment-gateway/paypal-webhook
// This endpoint must be public (no auth) — PayPal calls it server-to-server
const paypalWebhook = catchAsync(async (req, res) => {
  const result = await paymentGatewayService.handlePayPalWebhook(
    req.body,
    req.headers as Record<string, string>,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Webhook received",
    data: result,
  });
});

export const paymentGatewayController = { getConfig, updateConfig, oauthConnect, disconnectGateway, paypalWebhook };
