import { Router } from "express";
import { reportsController } from "./reports.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// All report endpoints require ADMIN or SUPER_ADMIN auth
router.use(checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN));

// GET /api/v1/reports/revenue?period=7d|30d|90d|12m
router.get("/revenue", reportsController.getRevenueReport);

// GET /api/v1/reports/staff-performance?period=7d|30d|90d|12m
router.get("/staff-performance", reportsController.getStaffPerformanceReport);

// GET /api/v1/reports/client-retention?period=7d|30d|90d|12m
router.get("/client-retention", reportsController.getClientRetentionReport);

<<<<<<< HEAD
=======
// GET /api/v1/reports/job-completion?period=7d|30d|90d|12m
router.get("/job-completion", reportsController.getJobCompletionReport);

// GET /api/v1/reports/:type/export?period=7d|30d|90d|12m
// type: revenue | staff-performance | client-retention | job-completion
// Returns: CSV file download
router.get("/:type/export", reportsController.exportReport);

>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6
export const reportsRoutes = router;
