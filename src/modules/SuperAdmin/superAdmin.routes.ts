import { Router } from "express";
import { superAdminController } from "./superAdmin.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

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

// POST /api/v1/super-admin/admin-accounts  ← NEW (item 12)
// Body: { name, email, password, businessName }
// Creates an admin account bypassing email verification — account starts ACTIVE.
router.post(
    "/admin-accounts",
    isSuperAdmin,
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

// PATCH  /api/v1/super-admin/pricing-tiers/:tierId  (update a specific Plan price row)
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

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/cancel  (existing)
router.patch(
    "/subscriptions/:subscriptionId/cancel",
    isSuperAdmin,
    superAdminController.cancelSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/grant-payment  ← NEW (item 2)
// Body: { amount: number, method: "CASH"|"BANK_TRANSFER"|"CHEQUE"|"MANUAL", note?, transactionId?, periodMonths? }
router.patch(
    "/subscriptions/:subscriptionId/grant-payment",
    isSuperAdmin,
    superAdminController.grantManualPayment,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/suspend  ← NEW (item 3)
router.patch(
    "/subscriptions/:subscriptionId/suspend",
    isSuperAdmin,
    superAdminController.suspendSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/reactivate  ← NEW (item 4)
router.patch(
    "/subscriptions/:subscriptionId/reactivate",
    isSuperAdmin,
    superAdminController.reactivateSubscription,
);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/extend-trial  ← NEW (item 5)
// Body: { days: number }
router.patch(
    "/subscriptions/:subscriptionId/extend-trial",
    isSuperAdmin,
    superAdminController.extendTrial,
);

// POST /api/v1/super-admin/subscriptions/:subscriptionId/nudge  ← NEW (item 16)
// Sends a trial-expiry reminder email to the admin.
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

// PATCH /api/v1/super-admin/billing-history/:id/refund  ← NEW (item 13)
// Marks a BillingHistory record as REFUNDED.
router.patch(
    "/billing-history/:id/refund",
    isSuperAdmin,
    superAdminController.refundBillingRecord,
);

// GET /api/v1/super-admin/billing-history/:id/invoice  ← NEW (item 14)
// Returns the invoiceUrl for the billing record (or generates a placeholder).
router.get(
    "/billing-history/:id/invoice",
    isSuperAdmin,
    superAdminController.getBillingInvoice,
);

// ─── Platform Config (item 15) ────────────────────────────────────────────────
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
