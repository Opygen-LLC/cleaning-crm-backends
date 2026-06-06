import { prisma } from "../../lib/prisma/prisma";
import type { UpdateNotificationPrefsPayload } from "./notification.interface";

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
    // NotificationPreference.adminId references AdminProfile.id, NOT User.id.
    // We must resolve the admin profile first, exactly like getNotificationPrefs does.
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
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
    const adminId = await getAdminId(userId);
    return prisma.notification.findMany({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        take: 50,
    });
};

const markRead = async (userId: string, notificationId: string) => {
    const adminId = await getAdminId(userId);
    await prisma.notification.updateMany({
        where: { id: notificationId, adminId },
        data: { isRead: true },
    });
};

const markAllRead = async (userId: string) => {
    const adminId = await getAdminId(userId);
    await prisma.notification.updateMany({
        where: { adminId, isRead: false },
        data: { isRead: true },
    });
};

export const notificationService = {
    getNotificationPrefs,
    updateNotificationPrefs,
    getInbox,
    markRead,
    markAllRead,
};
