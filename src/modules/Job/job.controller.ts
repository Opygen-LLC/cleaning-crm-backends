import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { jobService } from "./job.service";
import { IQueryParams } from "../../interface/query.interface";

// ── CRUD ──────────────────────────────────────────────────────────────────────

const createJob = catchAsync(async (req, res) => {
    const result = await jobService.createJob(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Job created successfully",
        data: result,
    });
});

const getAllJobs = catchAsync(async (req, res) => {
    const queryParams = req.query as IQueryParams;

    const result = await jobService.getAllJobs(queryParams, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Jobs retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getJobById = catchAsync(async (req, res) => {
    const result = await jobService.getJobById(
        req.params.id as string,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job retrieved successfully",
        data: result,
    });
});

const updateJob = catchAsync(async (req, res) => {
    const result = await jobService.updateJob(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job updated successfully",
        data: result,
    });
});

const updateJobStatus = catchAsync(async (req, res) => {
    const result = await jobService.updateJobStatus(
        req.params.id as string,
        req.body.status,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job status updated successfully",
        data: result,
    });
});

const deleteJob = catchAsync(async (req, res) => {
    await jobService.deleteJob(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job deleted successfully",
        data: null,
    });
});

// ── Booking conversion ────────────────────────────────────────────────────────

const convertBookingToJob = catchAsync(async (req, res) => {
    const result = await jobService.convertBookingToJob(
        req.params.bookingId as string,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Booking converted to job successfully",
        data: result,
    });
});

// ── Staff Assignment ──────────────────────────────────────────────────────────

const assignStaff = catchAsync(async (req, res) => {
    const result = await jobService.assignStaff(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff assigned successfully",
        data: result,
    });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

const getJobStats = catchAsync(async (req, res) => {
    const result = await jobService.getJobStats(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job stats retrieved successfully",
        data: result,
    });
});

// ── Staff Availability ────────────────────────────────────────────────────────

const getStaffAvailability = catchAsync(async (req, res) => {
    const result = await jobService.getStaffAvailability(
        {
            date: req.query.date as string,
            durationMins: Number(req.query.durationMins),
        },
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff availability retrieved successfully",
        data: result,
    });
});

// ── [NEW] Phase 2 — Staff check-in / check-out ───────────────────────────────

const checkIn = catchAsync(async (req, res) => {
    const result = await jobService.checkIn(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checked in successfully",
        data: result,
    });
});

const checkOut = catchAsync(async (req, res) => {
    const result = await jobService.checkOut(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checked out successfully",
        data: result,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const jobController = {
    createJob,
    getAllJobs,
    getJobById,
    updateJob,
    updateJobStatus,
    deleteJob,
    convertBookingToJob,
    assignStaff,
    getJobStats,
    getStaffAvailability,
    // Phase 2
    checkIn,
    checkOut,
};
