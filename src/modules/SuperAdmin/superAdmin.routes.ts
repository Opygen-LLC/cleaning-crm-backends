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
router.get("/revenue", isSuperAdmin, superAdminController.getPlatformRevenueDashboard);

// ─── Activity Logs ────────────────────────────────────────────────────────────
// GET /api/v1/super-admin/activity-logs
// Query: searchTerm, action, entityType, adminId, startDate, endDate, page, limit
router.get("/activity-logs", isSuperAdmin, superAdminController.getActivityLogs);

// GET /api/v1/super-admin/activity-logs/stats
router.get("/activity-logs/stats", isSuperAdmin, superAdminController.getActivityLogStats);

// ─── Admin Account Management ─────────────────────────────────────────────────
// GET /api/v1/super-admin/admin-accounts
// Query: searchTerm, status, subscriptionStatus, page, limit
router.get("/admin-accounts", isSuperAdmin, superAdminController.getAllAdminAccounts);

// GET /api/v1/super-admin/admin-accounts/:adminId
router.get("/admin-accounts/:adminId", isSuperAdmin, superAdminController.getAdminAccountById);

// PATCH /api/v1/super-admin/admin-accounts/:adminId/suspend
router.patch("/admin-accounts/:adminId/suspend", isSuperAdmin, superAdminController.suspendAdminAccount);

// PATCH /api/v1/super-admin/admin-accounts/:adminId/activate
router.patch("/admin-accounts/:adminId/activate", isSuperAdmin, superAdminController.activateAdminAccount);

// ─── Subscription Plan CRUD ───────────────────────────────────────────────────
// POST   /api/v1/super-admin/subscription-plans
// Body: { name, description, currency, features[], plans[{interval, price, ...}] }
router.post("/subscription-plans", isSuperAdmin, superAdminController.createSubscriptionPlan);

// PATCH  /api/v1/super-admin/subscription-plans/:planId
router.patch("/subscription-plans/:planId", isSuperAdmin, superAdminController.updateSubscriptionPlan);

// DELETE /api/v1/super-admin/subscription-plans/:planId
router.delete("/subscription-plans/:planId", isSuperAdmin, superAdminController.deleteSubscriptionPlan);

// PATCH  /api/v1/super-admin/pricing-tiers/:tierId  (update a specific Plan price row)
router.patch("/pricing-tiers/:tierId", isSuperAdmin, superAdminController.updatePricingTier);

// ─── Subscription Management ──────────────────────────────────────────────────
// GET    /api/v1/super-admin/subscriptions
// Query: status, planId, isTrial, page, limit
router.get("/subscriptions", isSuperAdmin, superAdminController.getAllSubscriptions);

// PATCH  /api/v1/super-admin/subscriptions/:subscriptionId/cancel
router.patch("/subscriptions/:subscriptionId/cancel", isSuperAdmin, superAdminController.cancelSubscription);

// ─── Billing History ──────────────────────────────────────────────────────────
// GET /api/v1/super-admin/billing-history
// Query: adminId, subscriptionId, startDate, endDate, page, limit
router.get("/billing-history", isSuperAdmin, superAdminController.getBillingHistory);

export const superAdminRoutes = router;
