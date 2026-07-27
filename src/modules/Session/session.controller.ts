import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { sessionService } from "./session.service";
import { CookieUtils } from "../../lib/utils/cookie";

const getMySessions = catchAsync(async (req, res) => {
    const refreshToken = CookieUtils.getCookie(req, "refreshToken") || (req.headers["x-refresh-token"] as string);
    const userAgent = req.headers["user-agent"];
    const ipAddress = ((req.headers["x-forwarded-for"] as string) || req.ip)?.toString();

    const result = await sessionService.getMySessions(req.user, {
        refreshToken,
        userAgent,
        ipAddress,
    });

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
