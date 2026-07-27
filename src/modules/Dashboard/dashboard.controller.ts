import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { dashboardService } from "./dashboard.service";

const getDashboardOverview = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await dashboardService.getDashboardOverview(userId, req.query);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Dashboard overview fetched successfully",
        data: result,
    });
});


const getRevenueData = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const period = (req.query.period as "7d" | "30d" | "90d" | "12m") ?? "30d";

    const validPeriods = ["7d", "30d", "90d", "12m"];
    if (!validPeriods.includes(period)) {
        sendResponse(res, {
            httpStatusCode: status.BAD_REQUEST,
            success: false,
            message: `Invalid period. Must be one of: ${validPeriods.join(", ")}`,
        });
        return;
    }

    const result = await dashboardService.getRevenuePage(userId, period);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Revenue data fetched successfully",
        data: result,
    });
});

const getStaffDashboard = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await dashboardService.getStaffDashboard(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff dashboard fetched successfully",
        data: result,
    });
});

export const dashboardController = {
    getDashboardOverview,
    getRevenueData,
    getStaffDashboard,
};
