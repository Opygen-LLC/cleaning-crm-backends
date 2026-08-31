import status from "http-status";
import { bumpCacheResourcesForUser, CacheResource } from "../../lib/cache/resourceCacheVersion";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { leadActivityService } from "./leadActivity.service";

const param = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

const getActivities = catchAsync(async (req, res) => {
    const result = await leadActivityService.getActivities(param(req.params.id), req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead activities retrieved successfully",
        data: result,
    });
});

const createActivity = catchAsync(async (req, res) => {
    const result = await leadActivityService.createActivity(param(req.params.id), req.body, req.user);
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Lead activity created successfully",
        data: result,
    });
});

const updateActivity = catchAsync(async (req, res) => {
    const result = await leadActivityService.updateActivity(
        param(req.params.id),
        param(req.params.activityId),
        req.body,
        req.user,
    );
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead activity updated successfully",
        data: result,
    });
});

const deleteActivity = catchAsync(async (req, res) => {
    await leadActivityService.deleteActivity(
        param(req.params.id),
        param(req.params.activityId),
        req.user,
    );
    await bumpCacheResourcesForUser(req.user, [CacheResource.leads, CacheResource.dashboard]);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Lead activity removed successfully",
        data: null,
    });
});

export const leadActivityController = {
    getActivities,
    createActivity,
    updateActivity,
    deleteActivity,
};
