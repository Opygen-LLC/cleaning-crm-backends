import { Router } from "express";
import { subscriptionController } from "./subscription.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// GET  /api/v1/subscription/me  — get current admin's subscription
router.get(
    "/me",
    checkAuth(UserRole.ADMIN),
    subscriptionController.getMySubscription,
);

// GET  /api/v1/subscription/me/billing-history
router.get(
    "/me/billing-history",
    checkAuth(UserRole.ADMIN),
    subscriptionController.getMyBillingHistory,
);

// PATCH /api/v1/subscription/me/change-plan
// Body: { planId: string, couponCode?: string }
router.patch(
    "/me/change-plan",
    checkAuth(UserRole.ADMIN),
    subscriptionController.changePlan,
);

// PATCH /api/v1/subscription/me/cancel
router.patch(
    "/me/cancel",
    checkAuth(UserRole.ADMIN),
    subscriptionController.cancelAtPeriodEnd,
);

// PATCH /api/v1/subscription/me/resume
router.patch(
    "/me/resume",
    checkAuth(UserRole.ADMIN),
    subscriptionController.resumeSubscription,
);

// PATCH /api/v1/subscription/me/submit-proof  ← NEW (item 6)
// Body: { paymentProofUrl: string, amount: number, method: string, note?, transactionId? }
// Tenant uploads proof image to Cloudinary first, then sends the URL here.
// Sets subscription status=PENDING_PAYMENT and creates a BillingHistory(PENDING) record.
router.patch(
    "/me/submit-proof",
    checkAuth(UserRole.ADMIN),
    subscriptionController.submitPaymentProof,
);

export const subscriptionRoutes = router;
