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

/**
 * POST /user/me/avatar
 * Multipart upload (field: "avatar") → Cloudinary → user.image updated.
 * Returns { avatarUrl: string } pointing to the Cloudinary secure URL.
 */
const uploadMyAvatar = catchAsync(async (req, res) => {
    if (!req.file) {
        sendResponse(res, {
            httpStatusCode: status.BAD_REQUEST,
            success: false,
            message: "No file uploaded",
        });
        return;
    }

    const result = await userService.uploadMyAvatar(
        req.user.id,
        req.file.buffer,
        req.file.mimetype,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Avatar uploaded successfully",
        data: result,
    });
});

export const userController = {
    getMe,
    getAllUsers,
    getUserById,
    updateUser,
    uploadMyAvatar,
};
