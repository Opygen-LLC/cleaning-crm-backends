import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { staffService } from "./staff.service";
import { IQueryParams } from "../../interface/query.interface";

const createStaff = catchAsync(async (req, res) => {
    const result = await staffService.createStaff(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Staff created successfully",
        data: result,
    });
});

const getMyStaff = catchAsync(async (req, res) => {
    const query = req.query;
    const result = await staffService.getMyStaff(
        query as IQueryParams,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff retrieved successfully",
        data: result,
    });
});

const updateStaff = catchAsync(async (req, res) => {
    const { id } = req.params;
    const payload = req.body;
    const result = await staffService.updateStaff(id as string, payload);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff updated successfully",
        data: result,
    });
});

const deleteStaff = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await staffService.deleteStaff(id as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Staff deleted successfully",
        data: result,
    });
});

export const staffController = {
    createStaff,
    getMyStaff,
    updateStaff,
    deleteStaff,
};
