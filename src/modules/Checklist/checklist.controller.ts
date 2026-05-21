import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { checklistService } from "./checklist.service";

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

// ── Template CRUD ─────────────────────────────────────────────────────────────

const createTemplate = catchAsync(async (req, res) => {
    const result = await checklistService.createTemplate(req.body, req.user);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Checklist template created successfully",
        data: result,
    });
});

const getAllTemplates = catchAsync(async (req, res) => {
    const result = await checklistService.getAllTemplates(req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checklist templates retrieved successfully",
        data: result,
    });
});

const getTemplateById = catchAsync(async (req, res) => {
    const result = await checklistService.getTemplateById(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checklist template retrieved successfully",
        data: result,
    });
});

const updateTemplate = catchAsync(async (req, res) => {
    const result = await checklistService.updateTemplate(
        getParam(req.params.id),
        req.body,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checklist template updated successfully",
        data: result,
    });
});

const deleteTemplate = catchAsync(async (req, res) => {
    await checklistService.deleteTemplate(getParam(req.params.id), req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checklist template deleted successfully",
        data: null,
    });
});

// ── Job Checklist ─────────────────────────────────────────────────────────────

const attachToJob = catchAsync(async (req, res) => {
    const result = await checklistService.attachToJob(
        getParam(req.params.jobId),
        req.body.templateId,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Checklist attached to job successfully",
        data: result,
    });
});

const getJobChecklists = catchAsync(async (req, res) => {
    const result = await checklistService.getJobChecklists(
        getParam(req.params.jobId),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Job checklists retrieved successfully",
        data: result,
    });
});

const updateItemCompletion = catchAsync(async (req, res) => {
    const result = await checklistService.updateItemCompletion(
        getParam(req.params.checklistId),
        getParam(req.params.itemId),
        req.body.completed,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Item marked as ${req.body.completed ? "complete" : "incomplete"}`,
        data: result,
    });
});

const detachFromJob = catchAsync(async (req, res) => {
    await checklistService.detachFromJob(getParam(req.params.checklistId), req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Checklist removed from job",
        data: null,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const checklistController = {
    createTemplate,
    getAllTemplates,
    getTemplateById,
    updateTemplate,
    deleteTemplate,
    attachToJob,
    getJobChecklists,
    updateItemCompletion,
    detachFromJob,
};
