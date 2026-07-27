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

// ── Report getters ─────────────────────────────────────────────────────────────

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

// ── Export endpoints ───────────────────────────────────────────────────────────

type ExportType =
    | "revenue"
    | "staff-performance"
    | "client-retention"
    | "job-completion";

const EXPORT_MAP: Record<
    ExportType,
    (userId: string, period: Period) => Promise<string>
> = {
    revenue: reportsService.exportRevenueReportCsv,
    "staff-performance": reportsService.exportStaffPerformanceCsv,
    "client-retention": reportsService.exportClientRetentionCsv,
    "job-completion": reportsService.exportJobCompletionCsv,
};

const VALID_TYPES = Object.keys(EXPORT_MAP) as ExportType[];

// GET /api/v1/reports/:type/export?period=7d|30d|90d|12m&format=csv|pdf
const exportReport = catchAsync(async (req, res) => {
    const type = req.params.type as ExportType;

    if (!VALID_TYPES.includes(type)) {
        res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: `Invalid report type. Valid types: ${VALID_TYPES.join(", ")}`,
        });
        return;
    }

    const period = parsePeriod(req.query.period);
    const format = (req.query.format as string)?.toLowerCase() === "pdf" ? "pdf" : "csv";

    if (format === "pdf" && type === "revenue") {
        const pdfBuffer = await reportsService.exportRevenueReportPdf(req.user.id, period);
        const filename = `${type}-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.status(httpStatus.OK).end(pdfBuffer);
        return;
    }

    const csv = await EXPORT_MAP[type](req.user.id, period);
    const filename = `${type}-report-${period}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(httpStatus.OK).send(csv);
});


export const reportsController = {
    getRevenueReport,
    getStaffPerformanceReport,
    getClientRetentionReport,
    getJobCompletionReport,
    exportReport,
};
