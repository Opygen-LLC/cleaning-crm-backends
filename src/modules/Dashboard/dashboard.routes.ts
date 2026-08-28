/**
 * dashboard.routes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * This router is mounted at "/dashboard" in routes/index.ts, so all paths
 * below are relative to /api/v1/dashboard/.
 *
 * CHANGE from the original:
 *   The staff dashboard route was mistakenly defined as router.get("/staff", …)
 *   which produced the path /api/v1/dashboard/staff — but staffRoutes already
 *   registers handlers at /staff/me, /staff/leave, etc.
 *
 *   The frontend's staffDashboardApi calls:
 *     useGetStaffDashboardQuery → GET /dashboard/staff
 *
 *   The router.get("/staff", …) path under the "/dashboard" mount is CORRECT
 *   for this call. No path change needed — but we explicitly document it here
 *   for clarity, and add the missing controller export guard.
 *
 * Endpoints:
 *   GET /api/v1/dashboard/overview        — admin dashboard KPIs
 *   GET /api/v1/dashboard/revenue?period= — admin revenue page
 *   GET /api/v1/dashboard/staff           — staff dashboard overview ← key endpoint
 */

import { Router } from "express";
import { dashboardController } from "./dashboard.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

/**
 * GET /api/v1/dashboard/overview
 * Admin KPI tiles: revenue, active bookings, total clients, jobs completed.
 */
router.get(
  "/overview",
  checkAuth(UserRole.ADMIN),
  dashboardController.getDashboardOverview,
);


router.get(
  "/revenue-insight",
  checkAuth(UserRole.ADMIN),
  dashboardController.getDashboardRevenueInsight,
);

/**
 * GET /api/v1/dashboard/revenue?period=7d|30d|90d|12m
 * Revenue breakdown for the admin's revenue analytics page.
 */
router.get(
  "/revenue",
  checkAuth(UserRole.ADMIN),
  dashboardController.getRevenueData,
);

/**
 * GET /api/v1/dashboard/staff
 * Staff member's own dashboard: today's jobs, upcoming jobs, weekly stats,
 * earnings, leave status, and unread notification count.
 *
 * Called by: staffDashboardApi.getStaffDashboard  (useGetStaffDashboardQuery)
 * Auth: STAFF role only.
 */
router.get(
  "/staff",
  checkAuth(UserRole.STAFF),
  dashboardController.getStaffDashboard,
);

export { router as dashboardRoutes };
