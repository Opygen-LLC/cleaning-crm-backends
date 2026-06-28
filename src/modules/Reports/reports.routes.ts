/**
 * reports.routes.ts — Phase 1 Production Version
 *
 * All report endpoints already have correct service implementations.
 * This version adds the GROWTH plan feature gate (checkFeature) to ensure
 * the API layer blocks non-GROWTH plan admins, matching the FE gate.
 *
 * Feature strings match featureGateConfig.ts GATES:
 *   reports              → GROWTH
 *   revenue reports      → GROWTH
 *   staff performance    → GROWTH
 *   client retention     → GROWTH
 *   job completion       → GROWTH
 */

import { Router } from "express";
import { reportsController } from "./reports.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// All report endpoints require ADMIN auth
router.use(checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN));

// GET /api/v1/reports/revenue?period=7d|30d|90d|12m
router.get("/revenue", checkFeature("revenue reports"), reportsController.getRevenueReport);

// GET /api/v1/reports/staff-performance?period=7d|30d|90d|12m
router.get("/staff-performance", checkFeature("staff performance reports"), reportsController.getStaffPerformanceReport);

// GET /api/v1/reports/client-retention?period=7d|30d|90d|12m
router.get("/client-retention", checkFeature("client retention reports"), reportsController.getClientRetentionReport);

// GET /api/v1/reports/job-completion?period=7d|30d|90d|12m
router.get("/job-completion", checkFeature("job completion reports"), reportsController.getJobCompletionReport);

// GET /api/v1/reports/:type/export?period=7d|30d|90d|12m
// type: revenue | staff-performance | client-retention | job-completion
router.get("/:type/export", checkFeature("reports"), reportsController.exportReport);

export const reportsRoutes = router;
