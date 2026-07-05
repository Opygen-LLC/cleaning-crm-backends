import { deleteFileFromCloudinary } from "../../config/cloudinary";
import { uploadToCloudinary } from "../../lib/utils/cloudinary";
import { prisma } from "../../lib/prisma/prisma";
import { UpdateUserPayload, UploadAvatarResult } from "./user.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

const ALLOWED_AVATAR_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
];

const getMe = async (userId: string) => {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            admin: true,
            staff: true,
        },
    });
    if (!user) {
        throw new Error("User not found");
    }
    return user;
};

const getAllUsers = async () => {
    return await prisma.user.findMany({
        include: {
            admin: true,
            staff: true,
        },
    });
};

const getUserById = async (id: string) => {
    const user = await prisma.user.findUnique({
        where: { id },
        include: {
            admin: true,
            staff: true,
        },
    });
    if (!user) {
        throw new Error("User not found");
    }
    return user;
};

/**
 * POST /user/me/avatar
 *
 * Uploads a profile photo for the currently authenticated user (Admin or
 * Super Admin — Staff has its own equivalent at POST /staff/me/avatar).
 * Mirrors the Staff module's pattern: multipart file received via
 * multerMemory (in-memory buffer), streamed to Cloudinary with a stable
 * public_id so re-uploads simply overwrite the previous photo instead of
 * accumulating orphaned assets.
 */
const uploadMyAvatar = async (
    userId: string,
    fileBuffer: Buffer,
    mimeType: string,
): Promise<UploadAvatarResult> => {
    if (!ALLOWED_AVATAR_TYPES.includes(mimeType)) {
        throw new AppError(
            status.BAD_REQUEST,
            "Only JPEG, PNG, WEBP, and GIF images are allowed",
        );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    const result = await uploadToCloudinary(fileBuffer, {
        folder: "Cleaning-CRM/user-avatars",
        public_id: `user_${userId}`,
        overwrite: true,
        transformation: [
            { width: 400, height: 400, crop: "fill", gravity: "face" },
            { quality: "auto" },
        ],
    });

    await prisma.user.update({
        where: { id: userId },
        data: { image: result.secure_url },
    });

    return { avatarUrl: result.secure_url as string };
};

const updateUser = async (id: string, payload: UpdateUserPayload) => {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
        throw new Error("User not found");
    }

    if (user.image && payload.image) {
        await deleteFileFromCloudinary(user.image);
    }

    return await prisma.user.update({
        where: { id },
        data: payload,
    });
};

export const userService = {
    getMe,
    getAllUsers,
    getUserById,
    updateUser,
    uploadMyAvatar,
};
