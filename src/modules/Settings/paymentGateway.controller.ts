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

// GET /payment-gateway/stripe/connect-url
// Generates the Stripe OAuth URL and stores the CSRF state nonce in the DB.
const getStripeConnectUrl = catchAsync(async (req, res) => {
    const result = await paymentGatewayService.getStripeConnectUrl(req.user.id);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Stripe connect URL generated",
        data: result,
    });
});

// GET /payment-gateway/paypal/connect-url
// Calls PayPal partner-referrals API and returns the action_url for onboarding.
const getPayPalReferralUrl = catchAsync(async (req, res) => {
    const result = await paymentGatewayService.getPayPalReferralUrl(
        req.user.id,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "PayPal onboarding URL generated",
        data: result,
    });
});

// POST /payment-gateway/oauth
// Receives the authorization code + state from the OAuth callback and exchanges
// it for an access token. State nonce is verified to prevent CSRF.
const oauthConnect = catchAsync(async (req, res) => {
    const { gateway, code, state } = req.body as {
        gateway: "stripe" | "paypal";
        code: string;
        state?: string;
    };

    const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ??
        req.socket.remoteAddress ??
        undefined;

    const result = await paymentGatewayService.oauthConnect(
        req.user.id,
        gateway,
        code,
        state,
        ip,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `${gateway} connected successfully`,
        data: result,
    });
});

// POST /payment-gateway/disconnect
// Revokes the token on the provider's side and clears stored credentials.
const disconnectGateway = catchAsync(async (req, res) => {
    const { gateway } = req.body as { gateway: "stripe" | "paypal" };

    const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ??
        req.socket.remoteAddress ??
        undefined;

    const result = await paymentGatewayService.disconnectGateway(
        req.user.id,
        gateway,
        ip,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `${gateway} disconnected successfully`,
        data: result,
    });
});

// POST /payment-gateway/paypal-webhook  (public — no auth)
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

// POST /payment-gateway/stripe-webhook  (public — raw body required)
const stripeWebhook = catchAsync(async (req, res) => {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
        res.status(400).json({
            success: false,
            message: "Missing stripe-signature header",
        });
        return;
    }

    const result = await paymentGatewayService.handleStripeWebhook(
        req.body as Buffer,
        signature,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Webhook received",
        data: result,
    });
});

export const paymentGatewayController = {
    getConfig,
    updateConfig,
    getStripeConnectUrl,
    getPayPalReferralUrl,
    oauthConnect,
    disconnectGateway,
    paypalWebhook,
    stripeWebhook,
};
