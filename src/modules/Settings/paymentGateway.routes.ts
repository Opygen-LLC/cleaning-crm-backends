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

router.get(
    "/payment-gateway",
    checkAuth(UserRole.ADMIN),
    paymentGatewayController.getConfig,
);

router.patch(
    "/payment-gateway",
    checkAuth(UserRole.ADMIN),
    zodValidate(paymentGatewayValidation.update, ValidationProperty.BODY),
    paymentGatewayController.updateConfig,
);

export const paymentGatewayRoutes = router;
