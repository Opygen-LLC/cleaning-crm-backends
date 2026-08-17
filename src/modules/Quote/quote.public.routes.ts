import { Router } from "express";
import { quoteController } from "./quote.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { quoteValidation } from "./quote.validation";
import { publicMutationRateLimit, publicReadRateLimit, publicResourceMutationRateLimit, publicSensitiveNoStore } from "../../middlewares/publicApiSecurity";

/**
 * Public quote routes are mounted outside the subscription gate in
 * src/routes/index.ts. This is intentional: a client must still be able to
 * open/respond to a secure quote link even when an authenticated admin session
 * exists in the same browser and that tenant's subscription needs attention.
 */
const router = Router();

router.get("/:token", publicSensitiveNoStore, publicReadRateLimit, quoteController.getPublicQuote);

router.post(
    "/:token/action",
    publicSensitiveNoStore,
    publicMutationRateLimit,
    publicResourceMutationRateLimit,
    zodValidate(quoteValidation.publicQuoteAction, ValidationProperty.BODY),
    quoteController.publicQuoteAction,
);

export const quotePublicRoutes = router;
