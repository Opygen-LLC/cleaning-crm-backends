import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { dashboardService } from "./dashboard.service";

const getDashboardOverview = catchAsync(async (req, res) => {
    const result = await dashboardService.getDashboardOverview(req.user, req.query);

    // PERF FIX (audit #19): the service already caches this in Redis for 5
    // minutes, but every request still paid a full network round-trip.
    // `private` because this is per-admin data (not eligible for shared/CDN
    // caching); `max-age` matches the Redis TTL so the browser itself can
    // skip the request entirely on back-navigation within that window.
    res.set("Cache-Control", "private, max-age=300");

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Dashboard overview fetched successfully",
        data: result,
    });
});



const getDashboardRevenueInsight = catchAsync(async (req, res) => {
    const period = (req.query.period as string | undefined) ?? "30d";
    const validPeriods = ["7d", "30d", "90d", "12m"];
    if (!validPeriods.includes(period)) {
        sendResponse(res, {
            httpStatusCode: status.BAD_REQUEST,
            success: false,
            message: `Invalid period. Must be one of: ${validPeriods.join(", ")}`,
        });
        return;
    }

    const result = await dashboardService.getDashboardRevenueInsight(req.user, period);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Dashboard revenue insight fetched successfully",
        data: result,
    });
});

const getRevenueData = catchAsync(async (req, res) => {
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

    const result = await dashboardService.getRevenuePage(req.user, period);

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
    getDashboardRevenueInsight,
    getRevenueData,
    getStaffDashboard,
};
