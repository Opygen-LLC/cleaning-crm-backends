import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { estimateFormService } from "./estimateForm.service";
import { IQueryParams } from "../../interface/query.interface";

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

// ── EstimateForm CRUD ─────────────────────────────────────────────────────────

const createEstimateForm = catchAsync(async (req, res) => {
    const result = await estimateFormService.createEstimateForm(req.body, req.user);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate form created successfully",
        data: result,
    });
});

const getAllEstimateForms = catchAsync(async (req, res) => {
    const result = await estimateFormService.getAllEstimateForms(
        req.query as IQueryParams,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate forms retrieved successfully",
        data: result,
    });
});

const getEstimateFormById = catchAsync(async (req, res) => {
    const result = await estimateFormService.getEstimateFormById(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate form retrieved successfully",
        data: result,
    });
});

const updateEstimateForm = catchAsync(async (req, res) => {
    const result = await estimateFormService.updateEstimateForm(
        getParam(req.params.id),
        req.body,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate form updated successfully",
        data: result,
    });
});

const deleteEstimateForm = catchAsync(async (req, res) => {
    await estimateFormService.deleteEstimateForm(getParam(req.params.id), req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate form deleted successfully",
        data: null,
    });
});

const togglePublished = catchAsync(async (req, res) => {
    const result = await estimateFormService.togglePublished(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Estimate form ${result.published ? "published" : "unpublished"} successfully`,
        data: result,
    });
});

// ── Submissions ───────────────────────────────────────────────────────────────

const getSubmissions = catchAsync(async (req, res) => {
    // formId may be provided as a query param when scoping to a single form
    const formId = req.query.formId as string | undefined;
    const result = await estimateFormService.getSubmissions(
        formId,
        req.query as IQueryParams,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submissions retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getFormSubmissions = catchAsync(async (req, res) => {
    const result = await estimateFormService.getSubmissions(
        getParam(req.params.id),
        req.query as IQueryParams,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submissions retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const updateSubmissionStatus = catchAsync(async (req, res) => {
    const result = await estimateFormService.updateSubmissionStatus(
        getParam(req.params.submissionId),
        req.body.status,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submission status updated successfully",
        data: result,
    });
});

// ── Public (unauthenticated) ──────────────────────────────────────────────────

const getPublicEstimateForm = catchAsync(async (req, res) => {
    const result = await estimateFormService.getPublicEstimateForm(getParam(req.params.slug));
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate form retrieved successfully",
        data: result,
    });
});

const calculatePublicEstimate = catchAsync(async (req, res) => {
    const result = await estimateFormService.calculatePublicEstimate(
        getParam(req.params.slug),
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Estimate calculated successfully",
        data: result,
    });
});

const submitPublicEstimateForm = catchAsync(async (req, res) => {
    const result = await estimateFormService.submitPublicEstimateForm(
        getParam(req.params.slug),
        req.body,
        req.get("Idempotency-Key") ?? undefined,
    );
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Estimate request submitted successfully. We'll be in touch shortly!",
        data: result,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const estimateFormController = {
    createEstimateForm,
    getAllEstimateForms,
    getEstimateFormById,
    updateEstimateForm,
    deleteEstimateForm,
    togglePublished,
    getSubmissions,
    getFormSubmissions,
    updateSubmissionStatus,
    getPublicEstimateForm,
    calculatePublicEstimate,
    submitPublicEstimateForm,
};
