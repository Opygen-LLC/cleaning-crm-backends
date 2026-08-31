import status from "http-status";
import AppError from "../../errorHelper/AppError";
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
    const result = await userService.getUserById(id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "User retrieved successfully",
        data: result,
    });
});

const updateMe = catchAsync(async (req, res) => {
    const result = await userService.updateUser(req.user.id, req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Profile updated successfully",
        data: result,
    });
});

const updateUser = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await userService.updateUser(id as string, req.body, req.user);

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
        throw new AppError(status.BAD_REQUEST, "No file uploaded", {
            code: "VALIDATION_ERROR",
            retryable: false,
            fieldErrors: { avatar: "Choose an image to upload." },
        });
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
    updateMe,
    updateUser,
    uploadMyAvatar,
};
