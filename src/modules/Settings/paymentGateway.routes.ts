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
// Full paths: GET /api/v1/payment-gateway  |  PATCH /api/v1/payment-gateway
// (removed the nested /payment-gateway segment to avoid /payment-gateway/payment-gateway double-path)

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

export const paymentGatewayRoutes = router;
