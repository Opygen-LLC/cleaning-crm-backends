import { prisma } from "../../lib/prisma/prisma";
import type { UpdateNotificationPrefsPayload } from "./notification.interface";
import redis from "../../config/redis";
import { getAdminId as resolveAdminId } from "../../lib/utils/resolveAdminId";

const getNotificationPrefs = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true, notificationPrefs: true },
    });

    if (!admin) throw new Error("Admin profile not found");

    // Auto-create with schema defaults if row doesn't exist yet
    if (!admin.notificationPrefs) {
        return prisma.notificationPreference.create({
            data: { adminId: admin.id },
        });
    }

    return admin.notificationPrefs;
};

const updateNotificationPrefs = async (
    userId: string,
    payload: UpdateNotificationPrefsPayload,
) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true },
    });

    if (!admin) throw new Error("Admin profile not found");

    return prisma.notificationPreference.upsert({
        where: { adminId: admin.id },
        update: payload,
        create: { adminId: admin.id, ...payload },
    });
};


// ─── Item 18: In-app notification inbox service methods ───────────────────────

const getAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true },
    });
    if (!admin) throw new Error("Admin profile not found");
    return admin.id;
};

const getInbox = async (userId: string) => {
    const adminId = await resolveAdminId({ id: userId } as any);
    const cacheKey = `notifications:${adminId}`;

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch {
            // fall through if corrupt
        }
    }

    const notifications = await prisma.notification.findMany({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        take: 50,
    });

    await redis.setex(cacheKey, 30, JSON.stringify(notifications)).catch(() => {});

    return notifications;
};

const markRead = async (userId: string, notificationId: string) => {
    const adminId = await resolveAdminId({ id: userId } as any);
    await prisma.notification.updateMany({
        where: { id: notificationId, adminId },
        data: { isRead: true },
    });
    await redis.del(`notifications:${adminId}`).catch(() => {});
};

const markAllRead = async (userId: string) => {
    const adminId = await resolveAdminId({ id: userId } as any);
    await prisma.notification.updateMany({
        where: { adminId, isRead: false },
        data: { isRead: true },
    });
    await redis.del(`notifications:${adminId}`).catch(() => {});
};

const getAdminPrefsByAdminId = async (adminId: string) => {
    const prefs = await prisma.notificationPreference.findUnique({
        where: { adminId },
    });

    if (!prefs) {
        return prisma.notificationPreference.create({
            data: { adminId },
        });
    }

    return prefs;
};

const shouldSendEmail = async (
    adminId: string,
    preferenceKey: keyof UpdateNotificationPrefsPayload,
): Promise<boolean> => {
    try {
        if (!adminId) return true;
        const prefs = await getAdminPrefsByAdminId(adminId);
        const val = prefs[preferenceKey];
        return typeof val === "boolean" ? val : true;
    } catch (err) {
        console.warn(`[NOTIFICATION SERVICE] Failed to fetch preferences for admin ${adminId}, defaulting to true:`, err);
        return true;
    }
};


export const notificationService = {
    getNotificationPrefs,
    updateNotificationPrefs,
    getAdminPrefsByAdminId,
    shouldSendEmail,
    getInbox,
    markRead,
    markAllRead,
};

