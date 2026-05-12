import { Router } from "express";
import { dashboardController } from "./dashboard.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// GET /api/v1/admin/dashboard/overview
router.get(
    "/dashboard/overview",
    checkAuth(UserRole.ADMIN),
    dashboardController.getDashboardOverview,
);

// GET /api/v1/admin/dashboard/revenue?period=7d|30d|90d|12m
router.get(
    "/dashboard/revenue",
    checkAuth(UserRole.ADMIN),
    dashboardController.getRevenueData,
);

export { router as dashboardRoutes };
