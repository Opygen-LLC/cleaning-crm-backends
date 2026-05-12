import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { notificationService } from "./notification.service";

const getPrefs = catchAsync(async (req, res) => {
    const result = await notificationService.getNotificationPrefs(req.user.id);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification preferences fetched successfully",
        data: result,
    });
});

const updatePrefs = catchAsync(async (req, res) => {
    const result = await notificationService.updateNotificationPrefs(
        req.user.id,
        req.body,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification preferences updated successfully",
        data: result,
    });
});

export const notificationController = { getPrefs, updatePrefs };
