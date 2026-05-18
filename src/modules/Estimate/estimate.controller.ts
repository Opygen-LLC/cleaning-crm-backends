import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { estimateService } from "./estimate.service";
import { IQueryParams } from "../../interface/query.interface";

// ── CRUD ──────────────────────────────────────────────────────────────────────

const createEstimate = catchAsync(async (req, res) => {
    const result = await estimateService.createEstimate(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate created successfully",
        data: result,
    });
});

const getAllEstimates = catchAsync(async (req, res) => {
    const queryParams = req.query as IQueryParams;
    const result = await estimateService.getAllEstimates(queryParams, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimates retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getEstimateById = catchAsync(async (req, res) => {
    const result = await estimateService.getEstimateById(
        req.params.id as string,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate retrieved successfully",
        data: result,
    });
});

const updateEstimate = catchAsync(async (req, res) => {
    const result = await estimateService.updateEstimate(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate updated successfully",
        data: result,
    });
});

const updateEstimateStatus = catchAsync(async (req, res) => {
    const result = await estimateService.updateEstimateStatus(
        req.params.id as string,
        req.body.status,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate status updated successfully",
        data: result,
    });
});

const deleteEstimate = catchAsync(async (req, res) => {
    await estimateService.deleteEstimate(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate deleted successfully",
        data: null,
    });
});

// ── Convert to Booking ────────────────────────────────────────────────────────

const convertEstimateToBooking = catchAsync(async (req, res) => {
    const result = await estimateService.convertEstimateToBooking(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate successfully converted to booking",
        data: result,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const estimateController = {
    createEstimate,
    getAllEstimates,
    getEstimateById,
    updateEstimate,
    updateEstimateStatus,
    deleteEstimate,
    convertEstimateToBooking,
};
