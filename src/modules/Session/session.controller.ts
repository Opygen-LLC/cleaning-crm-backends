import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { sessionService } from "./session.service";

const geMySession = catchAsync(async (req, res) => {
    const result = await sessionService.geMySession(req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "My session retrieved successfully",
        data: result,
    });
});

const deleteMySession = catchAsync(async (req, res) => {
    const result = await sessionService.deleteMySession(req.user, req.params.id as string);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "My session retrieved successfully",
        data: result,
    });
});

export const sessionController = {
	geMySession,
	deleteMySession
};