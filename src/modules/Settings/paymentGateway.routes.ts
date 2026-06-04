import { Router } from "express";
import express from "express";
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

router.get("/", checkAuth(UserRole.ADMIN), paymentGatewayController.getConfig);

router.patch(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.update, ValidationProperty.BODY),
    paymentGatewayController.updateConfig,
);

// FIX: Added missing OAuth connect and disconnect endpoints
router.post(
    "/oauth",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.oauthConnect,
);

router.post(
    "/disconnect",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.disconnectGateway,
);

// Public endpoint — PayPal calls this directly (no admin auth)
router.post("/paypal-webhook", paymentGatewayController.paypalWebhook);

// Public endpoint — Stripe calls this directly (no admin auth).
// express.raw() is required here so that the raw Buffer body is preserved for
// Stripe's HMAC signature verification. Using express.json() on this route
// would parse the body and make signature verification impossible.
router.post(
    "/stripe-webhook",
    express.raw({ type: "*/*" }),
    paymentGatewayController.stripeWebhook,
);

export const paymentGatewayRoutes = router;
