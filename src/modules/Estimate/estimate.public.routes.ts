import { Router } from "express";
import {
    publicMutationRateLimit,
    publicReadRateLimit,
    publicResourceMutationRateLimit,
    publicSensitiveNoStore,
} from "../../middlewares/publicApiSecurity";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { estimateController } from "./estimate.controller";
import { estimateValidation } from "./estimate.validation";

const router = Router();

router.get(
    "/:token/website/:websiteId",
    publicSensitiveNoStore,
    publicReadRateLimit,
    estimateController.getPublicEstimateForWebsite,
);
router.post(
    "/:token/website/:websiteId/action",
    publicSensitiveNoStore,
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    zodValidate(estimateValidation.publicEstimateAction, ValidationProperty.BODY),
    estimateController.publicEstimateActionForWebsite,
);

// Legacy direct-token routes remain available during rolling deployment. The
// canonical tenant-root frontend always uses the website-bound variants above.
router.get(
    "/:token",
    publicSensitiveNoStore,
    publicReadRateLimit,
    estimateController.getPublicEstimate,
);
router.post(
    "/:token/action",
    publicSensitiveNoStore,
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    zodValidate(estimateValidation.publicEstimateAction, ValidationProperty.BODY),
    estimateController.publicEstimateAction,
);

export const estimatePublicRoutes = router;
