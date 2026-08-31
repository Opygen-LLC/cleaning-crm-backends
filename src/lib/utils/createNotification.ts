import { prisma } from "../prisma/prisma";
import { emitToAdmin } from "../../config/socketio";
import { NotificationType } from "../../generated/prisma/enums";
import logger from "../logger";
import redis from "../../config/redis";
import { bumpCacheResourceVersions, CacheResource } from "../cache/resourceCacheVersion";

interface CreateNotificationPayload {
    adminId: string;
    type: NotificationType;
    title: string;
    message: string;
    relatedId?: string;
}

export async function createNotification(
    payload: CreateNotificationPayload,
): Promise<void> {
    try {
        // 1. Persist — so the inbox re-hydrates correctly after a page refresh
        const notification = await prisma.notification.create({
            data: {
                adminId:   payload.adminId,
                type:      payload.type,
                title:     payload.title,
                message:   payload.message,
                relatedId: payload.relatedId ?? null,
            },
        });

        // 2. Invalidate both notification cache layers before the live event.
        // The next inbox GET cannot observe the previous Redis generation.
        await Promise.all([
            redis.del(`notifications:${payload.adminId}`).catch(() => 0),
            bumpCacheResourceVersions(payload.adminId, [CacheResource.notifications]),
        ]);

        // 3. Push live to the admin's Socket.IO room
        emitToAdmin(payload.adminId, "notification:new", {
            id:        notification.id,
            type:      notification.type,      // uppercase enum value from Prisma
            title:     notification.title,
            message:   notification.message,
            createdAt: notification.createdAt.toISOString(),
            isRead:    false,
            relatedId: notification.relatedId,
        });
    } catch (err) {
        // Never let a notification failure bubble up and break the main flow
        logger.error("[createNotification] Failed", err);
    }
}
