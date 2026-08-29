import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { notificationService } from "./notification.service";

const getPrefs = catchAsync(async (req, res) => {
    const result = await notificationService.getNotificationPrefs(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification preferences fetched successfully",
        data: result,
    });
});

const updatePrefs = catchAsync(async (req, res) => {
    const result = await notificationService.updateNotificationPrefs(
        req.user,
        req.body,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification preferences updated successfully",
        data: result,
    });
});

// ─── Item 18: In-app notification REST endpoints ──────────────────────────────

const getInbox = catchAsync(async (req, res) => {
    const result = await notificationService.getInbox(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notifications fetched successfully",
        data: result,
    });
});

const markRead = catchAsync(async (req, res) => {
    await notificationService.markRead(req.user, req.params.id as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification marked as read",
        data: null,
    });
});

const markAllRead = catchAsync(async (req, res) => {
    await notificationService.markAllRead(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "All notifications marked as read",
        data: null,
    });
});

const getTemplates = catchAsync(async (req, res) => {
    const result = await notificationService.getTemplates(req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification templates fetched successfully",
        data: result,
    });
});

const upsertTemplate = catchAsync(async (req, res) => {
    const result = await notificationService.upsertTemplate(
        req.user,
        req.params.key as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification template saved successfully",
        data: result,
    });
});

const deleteTemplate = catchAsync(async (req, res) => {
    const result = await notificationService.deleteTemplate(
        req.user,
        req.params.key as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Notification template reset successfully",
        data: result,
    });
});

export const notificationController = {
    getPrefs,
    updatePrefs,
    getInbox,
    markRead,
    markAllRead,
    getTemplates,
    upsertTemplate,
    deleteTemplate,
};
