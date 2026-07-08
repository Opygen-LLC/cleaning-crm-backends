import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { sessionService } from "./session.service";

const getMySessions = catchAsync(async (req, res) => {
    const result = await sessionService.getMySessions(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Sessions retrieved successfully",
        data: result,
    });
});

const deleteMySession = catchAsync(async (req, res) => {
    const result = await sessionService.deleteMySession(
        req.user,
        req.params.id as string,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Session revoked successfully",
        data: result,
    });
});

export const sessionController = {
    getMySessions,
    deleteMySession,
};
