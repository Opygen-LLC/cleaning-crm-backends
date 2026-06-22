import { Router } from "express";
import { superAdminController } from "./superAdmin.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    zodValidate,
    ValidationProperty,
} from "../../middlewares/validations/zodValidation.middleware";
import { createAdminAccountSchema } from "./superAdmin.validation";

const router = Router();

// All routes require SUPER_ADMIN role
const isSuperAdmin = checkAuth(UserRole.SUPER_ADMIN);

// ─── Platform Overview ────────────────────────────────────────────────────────
// GET /api/v1/super-admin/stats
router.get("/stats", isSuperAdmin, superAdminController.getPlatformStats);

// ─── Revenue Dashboard ────────────────────────────────────────────────────────
// GET /api/v1/super-admin/revenue
// Query: startDate, endDate, interval (daily|weekly|monthly)
router.get(
    "/revenue",
    isSuperAdmin,
    superAdminController.getPlatformRevenueDashboard,
);

// ─── Activity Logs ────────────────────────────────────────────────────────────
// GET /api/v1/super-admin/activity-logs
// Query: searchTerm, action, entityType, adminId, startDate, endDate, page, limit
router.get(
    "/activity-logs",
    isSuperAdmin,
    superAdminController.getActivityLogs,
);

// GET /api/v1/super-admin/activity-logs/stats
router.get(
    "/activity-logs/stats",
    isSuperAdmin,
    superAdminController.getActivityLogStats,
);

// ─── Admin Account Management ─────────────────────────────────────────────────
// GET /api/v1/super-admin/admin-accounts
// Query: searchTerm, status, subscriptionStatus, page, limit
router.get(
    "/admin-accounts",
    isSuperAdmin,
    superAdminController.getAllAdminAccounts,
);

// GET /api/v1/super-admin/admin-accounts/:adminId
router.get(
    "/admin-accounts/:adminId",
    isSuperAdmin,
    superAdminController.getAdminAccountById,
);

// PATCH /api/v1/super-admin/admin-accounts/:adminId/suspend
router.patch(
    "/admin-accounts/:adminId/suspend",
    isSuperAdmin,
    superAdminController.suspendAdminAccount,
);

// PATCH /api/v1/super-admin/admin-accounts/:adminId/activate
router.patch(
    "/admin-accounts/:adminId/activate",
    isSuperAdmin,
    superAdminController.activateAdminAccount,
);

// POST /api/v1/super-admin/admin-accounts
// Body: { name, email, password, businessName, sendWelcomeEmail? }
// Creates an admin account bypassing email verification — account starts ACTIVE.
router.post(
    "/admin-accounts",
    isSuperAdmin,
    zodValidate(createAdminAccountSchema, ValidationProperty.BODY),
    superAdminController.createAdminAccount,
);

// ─── Subscription Plan CRUD ───────────────────────────────────────────────────
// POST   /api/v1/super-admin/subscription-plans
// Body: { name, description, currency, features[], plans[{interval, price, ...}] }
router.post(
    "/subscription-plans",
    isSuperAdmin,
    superAdminController.createSubscriptionPlan,
);

// PATCH  /api/v1/super-admin/subscription-plans/:planId
router.patch(
    "/subscription-plans/:planId",
    isSuperAdmin,
    superAdminController.updateSubscriptionPlan,
);

// DELETE /api/v1/super-admin/subscription-plans/:planId
router.delete(
    "/subscription-plans/:planId",
    isSuperAdmin,
    superAdminController.deleteSubscriptionPlan,
);

// PATCH  /api/v1/super-admin/subscription-plans/:planId/toggle-status
// Body: { isActive: boolean }
router.patch(
    "/subscription-plans/:planId/toggle-status",
    isSuperAdmin,
    superAdminController.toggleSubscriptionPlanStatus,
);

// PATCH  /api/v1/super-admin/pricing-tiers/:tierId
router.patch(
    "/pricing-tiers/:tierId",
    isSuperAdmin,
    superAdminController.updatePricingTier,
);

// ─── Subscription Management ──────────────────────────────────────────────────
// GET    /api/v1/super-admin/subscriptions
// Query: status, planId, isTrial, page, limit
router.get(
    "/subscriptions",
    isSuperAdmin,
    superAdminController.getAllSubscriptions,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/cancel
router.patch(
    "/subscriptions/:subscriptionId/cancel",
    isSuperAdmin,
    superAdminController.cancelSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/grant-payment
// Body: { amount, method, note?, transactionId?, periodMonths? }
router.patch(
    "/subscriptions/:subscriptionId/grant-payment",
    isSuperAdmin,
    superAdminController.grantManualPayment,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/suspend
router.patch(
    "/subscriptions/:subscriptionId/suspend",
    isSuperAdmin,
    superAdminController.suspendSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/reactivate
router.patch(
    "/subscriptions/:subscriptionId/reactivate",
    isSuperAdmin,
    superAdminController.reactivateSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/extend-trial
// Body: { days: number }
router.patch(
    "/subscriptions/:subscriptionId/extend-trial",
    isSuperAdmin,
    superAdminController.extendTrial,
);

// POST /api/v1/super-admin/subscriptions/:subscriptionId/nudge
router.post(
    "/subscriptions/:subscriptionId/nudge",
    isSuperAdmin,
    superAdminController.sendTrialNudge,
);

// ─── Billing History ──────────────────────────────────────────────────────────
// GET /api/v1/super-admin/billing-history
// Query: adminId, subscriptionId, startDate, endDate, page, limit
router.get(
    "/billing-history",
    isSuperAdmin,
    superAdminController.getBillingHistory,
);

// IMPORTANT: static segments must come before /:id routes.
// GET /api/v1/super-admin/billing-history/pending-proofs
router.get(
    "/billing-history/pending-proofs",
    isSuperAdmin,
    superAdminController.getPendingProofs,
);

// PATCH /api/v1/super-admin/billing-history/:id/refund
router.patch(
    "/billing-history/:id/refund",
    isSuperAdmin,
    superAdminController.refundBillingRecord,
);

// GET /api/v1/super-admin/billing-history/:id/invoice
router.get(
    "/billing-history/:id/invoice",
    isSuperAdmin,
    superAdminController.getBillingInvoice,
);

// PATCH /api/v1/super-admin/billing-history/:id/approve-proof
// Body (optional): { periodMonths?, note? }
router.patch(
    "/billing-history/:id/approve-proof",
    isSuperAdmin,
    superAdminController.approvePaymentProof,
);

// PATCH /api/v1/super-admin/billing-history/:id/reject-proof
// Body (optional): { reason? }
router.patch(
    "/billing-history/:id/reject-proof",
    isSuperAdmin,
    superAdminController.rejectPaymentProof,
);

// ─── Platform Config ──────────────────────────────────────────────────────────
// GET  /api/v1/super-admin/platform-config
router.get(
    "/platform-config",
    isSuperAdmin,
    superAdminController.getPlatformConfig,
);
// PATCH /api/v1/super-admin/platform-config
router.patch(
    "/platform-config",
    isSuperAdmin,
    superAdminController.updatePlatformConfig,
);

export const superAdminRoutes = router;
