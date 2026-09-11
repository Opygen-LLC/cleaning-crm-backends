import { Router } from "express";
import { subscriptionController } from "./subscription.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    zodValidate,
    ValidationProperty,
} from "../../middlewares/validations/zodValidation.middleware";
import { subscriptionValidation } from "./subscription.validation";

const router = Router();

router.use(checkAuth(UserRole.ADMIN));

// Subscription routes intentionally live outside checkSubscription so expired
// accounts can still inspect plans, create a checkout and submit payment proof.
router.get("/me", subscriptionController.getMySubscription);
router.get("/me/billing-history", subscriptionController.getMyBillingHistory);

// Recovery-only media path. It is intentionally outside checkSubscription so
// expired/suspended subscriptions can upload exactly one allowed media purpose:
// SUBSCRIPTION_PROOF. The controller/service never trust a client-sent purpose.
router.post(
    "/me/proof-upload/initiate",
    zodValidate(subscriptionValidation.proofUploadInitiateSchema, ValidationProperty.BODY),
    subscriptionController.initiateSubscriptionProofUpload,
);
router.post(
    "/me/proof-upload/:uploadId/complete",
    zodValidate(subscriptionValidation.proofUploadParamsSchema, ValidationProperty.PARAMS),
    subscriptionController.finalizeSubscriptionProofUpload,
);

router.patch(
    "/me/change-plan",
    zodValidate(subscriptionValidation.changePlanSchema, ValidationProperty.BODY),
    subscriptionController.changePlan,
);

router.patch(
    "/me/pending-plan-change/cancel",
    subscriptionController.cancelPendingPlanChange,
);

router.patch("/me/cancel", subscriptionController.cancelAtPeriodEnd);
router.patch("/me/resume", subscriptionController.resumeSubscription);

router.patch(
    "/me/submit-proof",
    zodValidate(
        subscriptionValidation.submitPaymentProofSchema,
        ValidationProperty.BODY,
    ),
    subscriptionController.submitPaymentProof,
);

export const subscriptionRoutes = router;
