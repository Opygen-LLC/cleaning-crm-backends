import { mediaService } from "../Media/media.service";
import { optimizeImage } from "../Media/imageOptimizer";
import { r2StorageService } from "../../lib/storage/r2Storage.service";
import { R2_PUBLIC_BUCKET } from "../../config/ENV";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma/prisma";
import { UpdateUserPayload, UploadAvatarResult } from "./user.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { AccountStatus, UserRole } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { invalidateRuntimeAuth } from "../../lib/cache/authRuntimeCache";
import { revokeAllSessionsForUser } from "../Auth/sessionSecurity.service";
import { invalidatePrivateResponseCacheForUser } from "../../middlewares/privateResponseCache";
import { getAdminId } from "../../lib/utils/resolveAdminId";

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
        throw new AppError(status.NOT_FOUND, "User not found", {
            code: "USER_NOT_FOUND",
            retryable: false,
        });
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

const getUserById = async (id: string, requester: IRequestUser) => {
    if (requester.id !== id && requester.role !== UserRole.SUPER_ADMIN) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to view this user.");
    }
    const user = await prisma.user.findUnique({
        where: { id },
        include: { admin: true, staff: true },
    });
    if (!user) throw new AppError(status.NOT_FOUND, "User not found");
    return user;
};

/**
 * POST /user/me/avatar
 *
 * Uploads a profile photo for the currently authenticated user (Admin or
 * Super Admin — Staff has its own equivalent at POST /staff/me/avatar).
 * Multipart is retained only as a compatibility fallback. Tenant users use the
 * direct R2 media flow; platform super-admin avatars are optimized server-side
 * and written to an isolated system prefix.
 */
const uploadMyAvatar = async (
    requester: IRequestUser,
    fileBuffer: Buffer,
    mimeType: string,
    filename = "avatar",
): Promise<UploadAvatarResult> => {
    const normalizedMime = mimeType.toLowerCase();
    if (!ALLOWED_AVATAR_TYPES.includes(normalizedMime)) {
        throw new AppError(status.BAD_REQUEST, "Only JPEG, PNG, WEBP, and GIF images are allowed");
    }

    const user = await prisma.user.findUnique({ where: { id: requester.id }, select: { id: true, role: true, imageMediaAssetId: true } });
    if (!user) throw new AppError(status.NOT_FOUND, "User not found");

    let avatarUrl: string;
    let mediaAssetId: string | null = null;
    let platformObjectKey: string | null = null;
    if (requester.role === UserRole.SUPER_ADMIN) {
        // Super admins are platform users rather than tenant users, so their
        // avatar is kept in an isolated system prefix instead of pretending it
        // belongs to an organization MediaAsset.
        const optimized = await optimizeImage(fileBuffer, { contentType: normalizedMime, maxDimension: 512, targetBytes: 100 * 1024 });
        const objectKey = `system/super-admins/${requester.id}/avatars/${randomUUID()}.webp`;
        await r2StorageService.putObject({ bucket: R2_PUBLIC_BUCKET, key: objectKey, body: optimized.buffer, contentType: optimized.mimeType, isPublic: true });
        platformObjectKey = objectKey;
        avatarUrl = r2StorageService.publicUrl(objectKey);
    } else {
        const asset = await mediaService.uploadFromServer({
            purpose: "USER_AVATAR", entityId: requester.id, filename, contentType: normalizedMime, buffer: fileBuffer,
        }, requester);
        if (!asset.publicUrl) throw new AppError(status.CONFLICT, "Avatar is not publicly available yet.", { code: "MEDIA_NOT_READY", retryable: true });
        avatarUrl = asset.publicUrl;
        mediaAssetId = asset.id;
    }

    try {
        await prisma.user.update({ where: { id: requester.id }, data: { image: avatarUrl, imageMediaAssetId: mediaAssetId } });
    } catch (error) {
        if (mediaAssetId) {
            const adminId = await getAdminId(requester);
            await mediaService.deleteAssetIfUnreferencedForTenant(mediaAssetId, adminId).catch(() => undefined);
        } else if (platformObjectKey) {
            await r2StorageService.deleteObject(R2_PUBLIC_BUCKET, platformObjectKey).catch(() => undefined);
        }
        throw error;
    }
    if (requester.role !== UserRole.SUPER_ADMIN && user.imageMediaAssetId && user.imageMediaAssetId !== mediaAssetId) {
        const adminId = await getAdminId(requester);
        await mediaService.deleteAssetForTenant(user.imageMediaAssetId, adminId).catch(() => undefined);
    }
    invalidateRuntimeAuth(requester.id);
    await invalidatePrivateResponseCacheForUser(requester.id);
    return { avatarUrl };
};

const attachMyAvatarAsset = async (requester: IRequestUser, assetId: string): Promise<UploadAvatarResult> => {
    if (requester.role === UserRole.SUPER_ADMIN) throw new AppError(status.BAD_REQUEST, "Use the avatar upload endpoint for platform administrator avatars.");
    const current = await prisma.user.findUnique({ where: { id: requester.id }, select: { imageMediaAssetId: true } });
    if (!current) throw new AppError(status.NOT_FOUND, "User not found");
    const asset = await mediaService.bindReadyAsset(assetId, requester, "USER_AVATAR", requester.id);
    if (!asset.publicUrl) throw new AppError(status.CONFLICT, "Avatar is not publicly available yet.", { code: "MEDIA_NOT_READY", retryable: true });
    const adminId = await getAdminId(requester);
    try {
        await prisma.user.update({ where: { id: requester.id }, data: { image: asset.publicUrl, imageMediaAssetId: asset.id } });
    } catch (error) {
        await mediaService.deleteAssetIfUnreferencedForTenant(asset.id, adminId).catch(() => undefined);
        throw error;
    }
    if (current.imageMediaAssetId && current.imageMediaAssetId !== asset.id) {
        await mediaService.deleteAssetForTenant(current.imageMediaAssetId, adminId).catch(() => undefined);
    }
    invalidateRuntimeAuth(requester.id);
    await invalidatePrivateResponseCacheForUser(requester.id);
    return { avatarUrl: asset.publicUrl };
};

const updateUser = async (id: string, payload: UpdateUserPayload, requester: IRequestUser) => {
    const isSelf = requester.id === id;
    const isSuperAdmin = requester.role === UserRole.SUPER_ADMIN;
    if (!isSelf && !isSuperAdmin) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to update this user.");
    }
    if (payload.status !== undefined && !isSuperAdmin) {
        throw new AppError(status.FORBIDDEN, "Only a super administrator can change account status.");
    }

    const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, status: true },
    });
    if (!user) throw new AppError(status.NOT_FOUND, "User not found");

    const updated = await prisma.user.update({
        where: { id },
        data: payload,
    });

    invalidateRuntimeAuth(id);
    await invalidatePrivateResponseCacheForUser(id);
    if (payload.status === AccountStatus.SUSPENDED || payload.status === AccountStatus.DELETED) {
        await revokeAllSessionsForUser(id);
    }
    return updated;
};

export const userService = {
    getMe,
    getAllUsers,
    getUserById,
    updateUser,
    uploadMyAvatar,
    attachMyAvatarAsset,
};
