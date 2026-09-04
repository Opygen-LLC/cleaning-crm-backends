import { Router } from "express";
import { pricingRulesController } from "./pricingRules.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { pricingRulesValidation } from "./pricingRules.validation";

const router = Router();

// "advanced_pricing_rules" is the PRO-tier feature flag seeded on plans —
// see seedSubscriptionPlan.ts. Matches GATES.settingsEstimatePricing.
const isAdmin = checkAuth(UserRole.ADMIN);
const hasAdvancedPricingRules = checkFeature("advanced_pricing_rules");

// GET /api/v1/pricing-rules
router.get(
    "/",
    isAdmin,
    hasAdvancedPricingRules,
    pricingRulesController.getPricingRules,
);

// PUT /api/v1/pricing-rules  (upsert — replaces full ruleset)
router.put(
    "/",
    isAdmin,
    hasAdvancedPricingRules,
    zodValidate(pricingRulesValidation.upsertPricingRules, ValidationProperty.BODY),
    pricingRulesController.upsertPricingRules,
);

export const pricingRulesRoutes = router;
