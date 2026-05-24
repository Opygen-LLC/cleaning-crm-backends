import { Router } from "express";
import { paymentGatewayController } from "./paymentGateway.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { paymentGatewayValidation } from "./paymentGateway.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// Mounted at /payment-gateway in routes/index.ts
// Full paths:
//   GET   /api/v1/payment-gateway
//   PATCH /api/v1/payment-gateway
//   POST  /api/v1/payment-gateway/oauth
//   POST  /api/v1/payment-gateway/disconnect

router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.getConfig,
);

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
router.post(
    "/paypal-webhook",
    paymentGatewayController.paypalWebhook,
);

export const paymentGatewayRoutes = router;
