import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { pushService } from "./push.service";

const getPublicKey = catchAsync(async (_req, res) => {
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Push configuration fetched successfully",
        data: pushService.getPublicKey(),
    });
});

const subscribe = catchAsync(async (req, res) => {
    const result = await pushService.subscribe(req.user.id, req.body);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Push notifications enabled",
        data: result,
    });
});

const unsubscribe = catchAsync(async (req, res) => {
    const result = await pushService.unsubscribe(req.user.id, req.body.endpoint);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Push notifications disabled",
        data: result,
    });
});

export const pushController = { getPublicKey, subscribe, unsubscribe };
