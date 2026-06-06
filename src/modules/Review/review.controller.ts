import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { reviewService } from "./review.service";
import { IReviewFilters } from "./review.interface";

// ── Public endpoints ──────────────────────────────────────────────────────────

const validateReviewToken = catchAsync(async (req, res) => {
    const result = await reviewService.validateReviewToken(
        req.params.token as string,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Token valid.",
        data: result,
    });
});

const submitPublicReview = catchAsync(async (req, res) => {
    const result = await reviewService.submitPublicReview(
        req.params.token as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "Review submitted. Thank you!",
        data: result,
    });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

const getAllReviews = catchAsync(async (req, res) => {
    const filters = req.query as unknown as IReviewFilters;
    const result = await reviewService.getAllReviews(filters, req.user);
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Reviews retrieved.",
        data: result.data,
        meta: result.meta,
        stats: result.stats as Record<string, unknown>,
    });
});

const getReviewById = catchAsync(async (req, res) => {
    const result = await reviewService.getReviewById(
        req.params.id as string,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Review retrieved.",
        data: result,
    });
});

const updateReview = catchAsync(async (req, res) => {
    const result = await reviewService.updateReview(
        req.params.id as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Review updated.",
        data: result,
    });
});

const getStaffReviewSummaries = catchAsync(async (req, res) => {
    const result = await reviewService.getStaffReviewSummaries(req.user);
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Staff review summaries retrieved.",
        data: result,
    });
});

const generateTokenForJob = catchAsync(async (req, res) => {
    const result = await reviewService.generateTokenForJob(
        req.params.jobId as string,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "Review token generated.",
        data: result,
    });
});

const resendReviewEmail = catchAsync(async (req, res) => {
    const result = await reviewService.resendReviewEmail(
        req.params.id as string,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Review request email resent.",
        data: result,
    });
});

export const reviewController = {
    validateReviewToken,
    submitPublicReview,
    getAllReviews,
    getReviewById,
    updateReview,
    getStaffReviewSummaries,
    generateTokenForJob,
    resendReviewEmail,
};
