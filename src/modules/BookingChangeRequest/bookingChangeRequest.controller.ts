import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { bookingChangeRequestService } from "./bookingChangeRequest.service";
import AppError from "../../errorHelper/AppError";
import { BookingChangeRequestStatus } from "../../generated/prisma/enums";

// Client (portal): POST /client/portal/:portalToken/booking-requests
const createRequest = catchAsync(async (req, res) => {
    if (!req.portalClient) {
        throw new AppError(status.UNAUTHORIZED, "Invalid portal link");
    }

    const result = await bookingChangeRequestService.createRequest(
        req.body,
        req.portalClient,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Request submitted — the admin will review it shortly.",
        data: result,
    });
});

// Admin: GET /client/booking-requests
const getRequests = catchAsync(async (req, res) => {
    const result = await bookingChangeRequestService.getRequests(req.user, {
        status: req.query.status as BookingChangeRequestStatus | undefined,
    });

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking change requests retrieved successfully",
        data: result,
    });
});

// Admin: PATCH /client/booking-requests/:id/decision
const decideRequest = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await bookingChangeRequestService.decideRequest(
        id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message:
            req.body.action === "approve" ? "Request approved" : "Request rejected",
        data: result,
    });
});

export const bookingChangeRequestController = {
    createRequest,
    getRequests,
    decideRequest,
};
