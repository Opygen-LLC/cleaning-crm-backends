import { Router } from "express";
import { dashboardController } from "./dashboard.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// GET /api/v1/dashboard/overview  — admin dashboard
router.get(
    "/dashboard/overview",
    checkAuth(UserRole.ADMIN),
    dashboardController.getDashboardOverview,
);

// GET /api/v1/dashboard/revenue?period=7d|30d|90d|12m  — admin revenue
router.get(
    "/dashboard/revenue",
    checkAuth(UserRole.ADMIN),
    dashboardController.getRevenueData,
);

// GET /api/v1/dashboard/staff  — staff dashboard overview
router.get(
    "/staff",
    checkAuth(UserRole.STAFF),
    dashboardController.getStaffDashboard,
);

export { router as dashboardRoutes };
