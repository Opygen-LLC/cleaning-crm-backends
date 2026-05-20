import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { reportsService } from "./reports.service";

type Period = "7d" | "30d" | "90d" | "12m";
const VALID_PERIODS: Period[] = ["7d", "30d", "90d", "12m"];

function parsePeriod(raw: unknown): Period {
    if (typeof raw === "string" && VALID_PERIODS.includes(raw as Period)) {
        return raw as Period;
    }
    return "30d";
}

// GET /api/v1/reports/revenue?period=7d|30d|90d|12m
const getRevenueReport = catchAsync(async (req, res) => {
    const period = parsePeriod(req.query.period);
    const result = await reportsService.getRevenueReport(req.user.id, period);
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Revenue report fetched successfully",
        data: result,
    });
});

// GET /api/v1/reports/staff-performance?period=7d|30d|90d|12m
const getStaffPerformanceReport = catchAsync(async (req, res) => {
    const period = parsePeriod(req.query.period);
    const result = await reportsService.getStaffPerformanceReport(
        req.user.id,
        period,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Staff performance report fetched successfully",
        data: result,
    });
});

// GET /api/v1/reports/client-retention?period=7d|30d|90d|12m
const getClientRetentionReport = catchAsync(async (req, res) => {
    const period = parsePeriod(req.query.period);
    const result = await reportsService.getClientRetentionReport(
        req.user.id,
        period,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Client retention report fetched successfully",
        data: result,
    });
});

// GET /api/v1/reports/job-completion?period=7d|30d|90d|12m
const getJobCompletionReport = catchAsync(async (req, res) => {
    const period = parsePeriod(req.query.period);
    const result = await reportsService.getJobCompletionReport(
        req.user.id,
        period,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Job completion report fetched successfully",
        data: result,
    });
});

export const reportsController = {
    getRevenueReport,
    getStaffPerformanceReport,
    getClientRetentionReport,
    getJobCompletionReport,
};
