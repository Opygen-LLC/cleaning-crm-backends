import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { leadService } from "./lead.service";
import { IQueryParams } from "../../interface/query.interface";
import { LeadStage } from "../../generated/prisma/enums";
import { bumpCacheResourcesForUser, CacheResource } from "../../lib/cache/resourceCacheVersion";

const getParam = (value: string | string[]) =>
    Array.isArray(value) ? value[0] : value;

const createLead = catchAsync(async (req, res) => {
    const result = await leadService.createLead(req.body, req.user);
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);

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
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);

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
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);

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
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead deleted successfully",
        data: null,
    });
});

// POST /lead/:id/convert-to-client
const convertLeadToClient = catchAsync(async (req, res) => {
    const id = getParam(req.params.id);
    const result = await leadService.convertLeadToClient(id, req.user);
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.clients, CacheResource.dashboard, CacheResource.reports]);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: result.message,
        data: {
            clientId: result.clientId,
            clientName: result.clientName,
            portalAccessToken: result.portalAccessToken,
        },
    });
});

export const leadController = {
    createLead,
    getLeads,
    getLeadById,
    updateLead,
    updateLeadStage,
    deleteLead,
    convertLeadToClient,
};
