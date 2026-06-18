import { Router } from "express";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { paymentGatewayValidation } from "./paymentGateway.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { paymentGatewayController } from "./paymentGateway.controller";

const router = Router();

// Mounted at /payment-gateway in routes/index.ts
// Full paths:
//   GET   /api/v1/payment-gateway
//   PATCH /api/v1/payment-gateway
//   GET   /api/v1/payment-gateway/stripe/connect-url
//   POST  /api/v1/payment-gateway/oauth
//   POST  /api/v1/payment-gateway/disconnect
//
// Webhook routes are registered directly in routes/index.ts so they bypass
// the subscription gate — Stripe/PayPal call them server-to-server with no
// session cookie.

router.get("/", checkAuth(UserRole.ADMIN), paymentGatewayController.getConfig);

router.patch(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.update, ValidationProperty.BODY),
    paymentGatewayController.updateConfig,
);

// Generates a Stripe OAuth URL with a CSRF state nonce stored in the DB.
// The frontend redirects the user to the returned URL to begin the OAuth flow.
router.get(
    "/stripe/connect-url",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.getStripeConnectUrl,
);

// Generates a PayPal PPCP partner-referral onboarding URL.
// The frontend redirects the business owner to the returned URL.
// PayPal redirects back to /oauth/callback/paypal?merchantId=…
router.get(
    "/paypal/connect-url",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.getPayPalReferralUrl,
);

// OAuth connect — verifies state nonce, exchanges the authorization code for
// tokens, encrypts them, and stores them in PaymentGatewayConfig.
router.post(
    "/oauth",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.oauth, ValidationProperty.BODY),
    paymentGatewayController.oauthConnect,
);

// Disconnect — revokes the OAuth token on the provider's side, then clears
// all stored credentials from PaymentGatewayConfig.
router.post(
    "/disconnect",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.disconnect, ValidationProperty.BODY),
    paymentGatewayController.disconnectGateway,
);

export const paymentGatewayRoutes = router;
