import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { estimateService } from "./estimate.service";
import { IQueryParams } from "../../interface/query.interface";
import { bumpCacheResourcesForUser, CacheResource } from "../../lib/cache/resourceCacheVersion";

// ── CRUD ──────────────────────────────────────────────────────────────────────

const createEstimate = catchAsync(async (req, res) => {
    const result = await estimateService.createEstimate(req.body, req.user);
    if (req.body.newClient) {
        await bumpCacheResourcesForUser(req.user, [
            CacheResource.clients,
            CacheResource.dashboard,
            CacheResource.reports,
        ]);
    }

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


const shareEstimate = catchAsync(async (req, res) => {
    const result = await estimateService.shareEstimate(req.params.id as string, req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate client link activated successfully",
        data: result,
    });
});

const sendEstimateEmail = catchAsync(async (req, res) => {
    const result = await estimateService.sendEstimateEmail(req.params.id as string, req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate email queued successfully",
        data: result,
    });
});

const getPublicEstimate = catchAsync(async (req, res) => {
    const result = await estimateService.getPublicEstimate(req.params.token as string);
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate retrieved successfully",
        data: result,
    });
});

const getPublicEstimateForWebsite = catchAsync(async (req, res) => {
    const result = await estimateService.getPublicEstimate(
        req.params.token as string,
        req.params.websiteId as string,
    );
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate retrieved successfully",
        data: result,
    });
});

const publicEstimateAction = catchAsync(async (req, res) => {
    const result = await estimateService.publicEstimateAction(
        req.params.token as string,
        req.body.action,
        req.body.note,
    );
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Estimate ${req.body.action === "approve" ? "approved" : "rejected"} successfully`,
        data: result,
    });
});

const publicEstimateActionForWebsite = catchAsync(async (req, res) => {
    const result = await estimateService.publicEstimateAction(
        req.params.token as string,
        req.body.action,
        req.body.note,
        req.params.websiteId as string,
    );
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Estimate ${req.body.action === "approve" ? "approved" : "rejected"} successfully`,
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

    await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard, CacheResource.reports, CacheResource.clients]);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate successfully converted to booking",
        data: result,
    });
});

// ── Convert to Quote ──────────────────────────────────────────────────────────

const convertEstimateToQuote = catchAsync(async (req, res) => {
    const result = await estimateService.convertEstimateToQuote(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate successfully converted to quote",
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
    shareEstimate,
    sendEstimateEmail,
    getPublicEstimate,
    getPublicEstimateForWebsite,
    publicEstimateAction,
    publicEstimateActionForWebsite,
    deleteEstimate,
    convertEstimateToBooking,
    convertEstimateToQuote,
};
