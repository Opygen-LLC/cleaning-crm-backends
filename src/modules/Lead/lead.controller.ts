import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { leadService } from "./lead.service";
import { IQueryParams } from "../../interface/query.interface";
import { LeadStage } from "../../generated/prisma/enums";

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

const createLead = catchAsync(async (req, res) => {
    const result = await leadService.createLead(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Lead created successfully",
        data: result,
    });
});

const getLeads = catchAsync(async (req, res) => {
    const query = req.query as IQueryParams;
    const result = await leadService.getLeads(query, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Leads retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getLeadById = catchAsync(async (req, res) => {
    const id = getParam(req.params.id);
    const result = await leadService.getLeadById(id, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead retrieved successfully",
        data: result,
    });
});

const updateLead = catchAsync(async (req, res) => {
    const id = getParam(req.params.id);
    const result = await leadService.updateLead(id, req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead updated successfully",
        data: result,
    });
});

const updateLeadStage = catchAsync(async (req, res) => {
    const id = getParam(req.params.id);
    const { stage } = req.body as { stage: LeadStage };
    const result = await leadService.updateLeadStage(id, stage, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead stage updated successfully",
        data: result,
    });
});

const deleteLead = catchAsync(async (req, res) => {
    const id = getParam(req.params.id);
    await leadService.deleteLead(id, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead deleted successfully",
        data: null,
    });
});

export const leadController = {
    createLead,
    getLeads,
    getLeadById,
    updateLead,
    updateLeadStage,
    deleteLead,
};
