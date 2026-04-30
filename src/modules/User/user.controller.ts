import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { userService } from "./user.service";

const getMe = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const result = await userService.getMe(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "User profile retrieved successfully",
        data: result,
    });
});

const getAllUsers = catchAsync(async (req, res) => {
    const result = await userService.getAllUsers();

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Users retrieved successfully",
        data: result,
    });
});

const getUserById = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await userService.getUserById(id as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "User retrieved successfully",
        data: result,
    });
});

const updateUser = catchAsync(async (req, res) => {
    const { id } = req.params;
    const payload = req.body;

    if (req.file?.path) {
        payload.image = req.file.path; // 👈 Cloudinary URL
    }

    const result = await userService.updateUser(id as string, payload);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "User updated successfully",
        data: result,
    });
});

export const userController = {
    getMe,
    getAllUsers,
    getUserById,
    updateUser,
};
