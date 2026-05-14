import { prisma } from "../../lib/prisma/prisma";

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
    payload: Record<string, unknown>,
) => {
    return prisma.notificationPreference.upsert({
        where: { adminId: userId },
        update: payload,
        create: { adminId: userId, ...payload },
    });
};

export const notificationService = {
    getNotificationPrefs,
    updateNotificationPrefs,
};
