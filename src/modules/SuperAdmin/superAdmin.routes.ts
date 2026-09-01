import { Router } from "express";
import { superAdminController } from "./superAdmin.controller";
import { tenantAdminController } from "./tenantAdmin.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    zodValidate,
    ValidationProperty,
} from "../../middlewares/validations/zodValidation.middleware";
import {
    adminAccountListQuerySchema,
    createAdminAccountSchema,
    createSubscriptionPlanSchema,
    toggleSubscriptionPlanStatusSchema,
    updatePricingTierSchema,
    updateSubscriptionPlanSchema,
    subscriptionListQuerySchema,
} from "./superAdmin.validation";
import {
    tenantListQuerySchema, reasonSchema, tenantProfileSchema, tenantOwnerSchema, hardDeleteSchema,
    globalUsersQuerySchema, userRoleSchema, userStatusSchema, verifyUserSchema, subscriptionRequestQuerySchema,
    superAdminAuditQuerySchema,
    planChangeSchema, cancellationSchema, trialManagementSchema, entitlementSchema, platformConfigPatchSchema, subscriptionRequestReviewSchema,
} from "./tenantAdmin.validation";

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

// ─── Canonical Tenant Administration (Phase 1 parity) ─────────────────────────
router.get("/tenants", isSuperAdmin, zodValidate(tenantListQuerySchema, ValidationProperty.QUERY), tenantAdminController.getTenants);
router.get("/tenants/health", isSuperAdmin, tenantAdminController.getTenantsHealth);
router.get("/tenants/:adminId", isSuperAdmin, tenantAdminController.getTenant);
router.patch("/tenants/:adminId/profile", isSuperAdmin, zodValidate(tenantProfileSchema, ValidationProperty.BODY), tenantAdminController.updateProfile);
router.patch("/tenants/:adminId/owner", isSuperAdmin, zodValidate(tenantOwnerSchema, ValidationProperty.BODY), tenantAdminController.updateOwner);
router.post("/tenants/:adminId/suspend", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.suspend);
router.post("/tenants/:adminId/reactivate", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.reactivate);
router.post("/tenants/:adminId/archive", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.archive);
router.post("/tenants/:adminId/restore", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.restore);
router.get("/tenants/:adminId/deletion-preview", isSuperAdmin, tenantAdminController.deletionPreview);
router.post("/tenants/:adminId/hard-delete", isSuperAdmin, zodValidate(hardDeleteSchema, ValidationProperty.BODY), tenantAdminController.hardDelete);
router.post("/tenants/:adminId/subscription/change-plan", isSuperAdmin, zodValidate(planChangeSchema, ValidationProperty.BODY), tenantAdminController.changePlan);
router.post("/tenants/:adminId/subscription/schedule-downgrade", isSuperAdmin, zodValidate(planChangeSchema, ValidationProperty.BODY), tenantAdminController.scheduleDowngrade);
router.post("/tenants/:adminId/subscription/cancel-scheduled-change", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.cancelScheduled);
router.patch("/tenants/:adminId/subscription/cancellation", isSuperAdmin, zodValidate(cancellationSchema, ValidationProperty.BODY), tenantAdminController.cancellation);
router.patch("/tenants/:adminId/subscription/trial", isSuperAdmin, zodValidate(trialManagementSchema, ValidationProperty.BODY), tenantAdminController.trial);
router.get("/tenants/:adminId/entitlement-overrides", isSuperAdmin, tenantAdminController.getEntitlements);
router.put("/tenants/:adminId/entitlement-overrides", isSuperAdmin, zodValidate(entitlementSchema, ValidationProperty.BODY), tenantAdminController.setEntitlements);
router.delete("/tenants/:adminId/entitlement-overrides", isSuperAdmin, zodValidate(reasonSchema, ValidationProperty.BODY), tenantAdminController.revokeEntitlements);

// ─── Global Users ─────────────────────────────────────────────────────────────
router.get("/users", isSuperAdmin, zodValidate(globalUsersQuerySchema, ValidationProperty.QUERY), tenantAdminController.getUsers);
router.get("/users/summary", isSuperAdmin, tenantAdminController.getUsersSummary);
router.get("/users/export.csv", isSuperAdmin, zodValidate(globalUsersQuerySchema, ValidationProperty.QUERY), tenantAdminController.exportUsers);
router.patch("/users/:id/role", isSuperAdmin, zodValidate(userRoleSchema, ValidationProperty.BODY), tenantAdminController.changeRole);
router.patch("/users/:id/status", isSuperAdmin, zodValidate(userStatusSchema, ValidationProperty.BODY), tenantAdminController.changeStatus);
router.patch("/users/:id/verify", isSuperAdmin, zodValidate(verifyUserSchema, ValidationProperty.BODY), tenantAdminController.verify);

// ─── Super Admin Audit ────────────────────────────────────────────────────────
router.get("/audit-logs", isSuperAdmin, zodValidate(superAdminAuditQuerySchema, ValidationProperty.QUERY), tenantAdminController.auditLogs);
router.get("/audit-logs/stats", isSuperAdmin, tenantAdminController.auditStats);

// ─── Subscription Request Queue ───────────────────────────────────────────────
router.get("/subscription-requests", isSuperAdmin, zodValidate(subscriptionRequestQuerySchema, ValidationProperty.QUERY), tenantAdminController.subscriptionRequests);
router.patch("/subscription-requests/:id/approve", isSuperAdmin, zodValidate(subscriptionRequestReviewSchema, ValidationProperty.BODY), tenantAdminController.approveSubscriptionRequest);
router.patch("/subscription-requests/:id/reject", isSuperAdmin, zodValidate(subscriptionRequestReviewSchema, ValidationProperty.BODY), tenantAdminController.rejectSubscriptionRequest);

// ─── Admin Account Management ─────────────────────────────────────────────────
// GET /api/v1/super-admin/admin-accounts
// Query: searchTerm, status, subscriptionStatus, plan, isTrial, page, limit
router.get(
    "/admin-accounts",
    isSuperAdmin,
    zodValidate(adminAccountListQuerySchema, ValidationProperty.QUERY),
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
router.get(
    "/subscription-plans",
    isSuperAdmin,
    superAdminController.getSubscriptionPlans,
);
router.get(
    "/subscription-plans/:planId",
    isSuperAdmin,
    superAdminController.getSubscriptionPlanById,
);
// The database has four fixed enum tiers. POST is retained for disaster recovery
// if one fixed tier is missing, but the normal editor only edits/reactivates tiers.
router.post(
    "/subscription-plans",
    isSuperAdmin,
    zodValidate(createSubscriptionPlanSchema, ValidationProperty.BODY),
    superAdminController.createSubscriptionPlan,
);

// One atomic write for metadata, feature states and monthly/yearly pricing.
router.patch(
    "/subscription-plans/:planId",
    isSuperAdmin,
    zodValidate(updateSubscriptionPlanSchema, ValidationProperty.BODY),
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
    zodValidate(toggleSubscriptionPlanStatusSchema, ValidationProperty.BODY),
    superAdminController.toggleSubscriptionPlanStatus,
);

// PATCH  /api/v1/super-admin/pricing-tiers/:tierId
router.patch(
    "/pricing-tiers/:tierId",
    isSuperAdmin,
    zodValidate(updatePricingTierSchema, ValidationProperty.BODY),
    superAdminController.updatePricingTier,
);

// ─── Subscription Management ──────────────────────────────────────────────────
// GET    /api/v1/super-admin/subscriptions
// Query: status, planId, isTrial, search, plan, billingCycle, sortField, sortDir, page, limit
router.get(
    "/subscriptions",
    isSuperAdmin,
    zodValidate(subscriptionListQuerySchema, ValidationProperty.QUERY),
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
    zodValidate(platformConfigPatchSchema, ValidationProperty.BODY),
    superAdminController.updatePlatformConfig,
);

export const superAdminRoutes = router;
