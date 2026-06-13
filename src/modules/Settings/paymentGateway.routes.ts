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

// OAuth connect — exchanges the authorization code returned by Stripe/PayPal
// and stores the connected account / merchant ID.
router.post(
    "/oauth",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.oauth, ValidationProperty.BODY),
    paymentGatewayController.oauthConnect,
);

// Disconnect — revokes the OAuth connection and clears stored credentials.
router.post(
    "/disconnect",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.disconnect, ValidationProperty.BODY),
    paymentGatewayController.disconnectGateway,
);

export const paymentGatewayRoutes = router;
