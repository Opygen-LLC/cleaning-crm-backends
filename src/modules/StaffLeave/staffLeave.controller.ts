import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { staffLeaveService } from "./staffLeave.service";

// ─── Staff endpoints ──────────────────────────────────────────────────────────

/** POST /api/v1/staff/leave  — staff submits a leave request */
const requestLeave = catchAsync(async (req, res) => {
    const result = await staffLeaveService.requestLeave(req.user.id, req.body);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Leave request submitted successfully",
        data: result,
    });
});

/** GET /api/v1/staff/leave  — staff views their own leave requests */
const getMyLeaves = catchAsync(async (req, res) => {
    const result = await staffLeaveService.getMyLeaves(req.user.id);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Leave requests retrieved successfully",
        data: result,
    });
});

/** DELETE /api/v1/staff/leave/:id  — staff cancels a pending leave */
const cancelLeave = catchAsync(async (req, res) => {
    const result = await staffLeaveService.cancelLeave(
        req.user,
        req.params.id as string,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Leave request cancelled",
        data: result,
    });
});

// ─── Admin endpoints ──────────────────────────────────────────────────────────

/** GET /api/v1/staff/leave/all  — admin views all leave requests */
const getStaffLeaves = catchAsync(async (req, res) => {
    const query = {
        status: req.query.status as string | undefined,
        staffId: req.query.staffId as string | undefined,
    };

    const result = await staffLeaveService.getStaffLeaves(req.user, query);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff leave requests retrieved successfully",
        data: result,
    });
});

/** PATCH /api/v1/staff/leave/:id/review  — admin approves or declines */
const reviewLeave = catchAsync(async (req, res) => {
    const result = await staffLeaveService.reviewLeave(
        req.user,
        req.params.id as string,
        req.body,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Leave request ${req.body.decision === "APPROVED" ? "approved" : "declined"}`,
        data: result,
    });
});

export const staffLeaveController = {
    requestLeave,
    getMyLeaves,
    cancelLeave,
    getStaffLeaves,
    reviewLeave,
};
