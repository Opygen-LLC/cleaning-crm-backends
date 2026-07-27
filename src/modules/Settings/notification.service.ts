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

    // Clean payload: strip undefined / null keys before updating
    const cleanedPayload = Object.fromEntries(
        Object.entries(payload).filter(([, v]) => v !== undefined && v !== null),
    );

    return prisma.notificationPreference.upsert({
        where: { adminId: admin.id },
        update: cleanedPayload,
        create: { adminId: admin.id, ...cleanedPayload },
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

