import { Router } from "express";
import { pricingRulesController } from "./pricingRules.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { pricingRulesValidation } from "./pricingRules.validation";

const router = Router();

// GET /api/v1/pricing-rules
router.get(
    "/",
    checkAuth(UserRole.ADMIN),
    pricingRulesController.getPricingRules,
);

// PUT /api/v1/pricing-rules  (upsert — replaces full ruleset)
router.put(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(pricingRulesValidation.upsertPricingRules, ValidationProperty.BODY),
    pricingRulesController.upsertPricingRules,
);

export const pricingRulesRoutes = router;
