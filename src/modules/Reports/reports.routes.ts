/**
 * reports.routes.ts — Phase 1 Production Version
 *
 * All report endpoints already have correct service implementations.
 * This version adds the GROWTH plan feature gate (checkFeature) to ensure
 * the API layer blocks non-GROWTH plan admins, matching the FE gate.
 *
 * BUGFIX: every route below now uses the single checkFeature("reports") key.
 * seedSubscriptionPlan.ts only ever sets a generic { label: "Reports" }
 * flag on GROWTH/PRO/CUSTOM plans — it never sets the granular
 * "revenue reports" / "staff performance reports" / "client retention
 * reports" / "job completion reports" labels these routes previously
 * checked for individually. Since checkFeature requires an exact
 * (normalised) label match, every paying GROWTH/PRO/CUSTOM admin was
 * getting a 403 on every report endpoint except /:type/export (the only
 * route that happened to already use the correct "reports" key).
 */

import { Router } from "express";
import { reportsController } from "./reports.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// All report endpoints require ADMIN auth
router.use(checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN));

// "reports" is the single feature flag seeded on the GROWTH+ plans —
// see seedSubscriptionPlan.ts. Reuse one middleware instance for all routes.
const hasReports = checkFeature("reports");

// GET /api/v1/reports/revenue?period=7d|30d|90d|12m
router.get("/revenue", hasReports, reportsController.getRevenueReport);

// GET /api/v1/reports/staff-performance?period=7d|30d|90d|12m
router.get(
    "/staff-performance",
    hasReports,
    reportsController.getStaffPerformanceReport,
);

// GET /api/v1/reports/client-retention?period=7d|30d|90d|12m
router.get(
    "/client-retention",
    hasReports,
    reportsController.getClientRetentionReport,
);

// GET /api/v1/reports/job-completion?period=7d|30d|90d|12m
router.get(
    "/job-completion",
    hasReports,
    reportsController.getJobCompletionReport,
);

// GET /api/v1/reports/:type/export?period=7d|30d|90d|12m
// type: revenue | staff-performance | client-retention | job-completion
router.get("/:type/export", hasReports, reportsController.exportReport);

export const reportsRoutes = router;
