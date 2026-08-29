import { prisma } from "../../lib/prisma/prisma";
import type {
    UpdateNotificationPrefsPayload,
    UpsertNotificationTemplatePayload,
} from "./notification.interface";
import redis from "../../config/redis";
import { getAdminId as resolveAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import logger from "../../lib/logger";

export const CUSTOMISABLE_TEMPLATE_KEYS = [
    "booking-confirmation",
    "reminder-24h",
    "staff-assigned",
    "quote-sent",
    "invoice-due",
    "review-request",
] as const;

const assertTemplateKey = (key: string) => {
    if (!CUSTOMISABLE_TEMPLATE_KEYS.includes(key as (typeof CUSTOMISABLE_TEMPLATE_KEYS)[number])) {
        throw new AppError(status.BAD_REQUEST, "Unsupported notification template key");
    }
};

const getNotificationPrefs = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user);
    const prefs = await prisma.notificationPreference.findUnique({
        where: { adminId },
    });

    if (!prefs) {
        return prisma.notificationPreference.create({ data: { adminId } });
    }

    return prefs;
};

const updateNotificationPrefs = async (
    user: IRequestUser,
    payload: UpdateNotificationPrefsPayload,
) => {
    const adminId = await resolveAdminId(user);
    return prisma.notificationPreference.upsert({
        where: { adminId },
        update: payload,
        create: { adminId, ...payload },
    });
};

const getTemplates = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user);
    return prisma.notificationTemplate.findMany({
        where: { adminId },
        orderBy: { key: "asc" },
    });
};

const upsertTemplate = async (
    user: IRequestUser,
    key: string,
    payload: UpsertNotificationTemplatePayload,
) => {
    assertTemplateKey(key);
    const adminId = await resolveAdminId(user);
    return prisma.notificationTemplate.upsert({
        where: { adminId_key: { adminId, key } },
        create: {
            adminId,
            key,
            channel: "EMAIL",
            subject: payload.subject?.trim() || null,
            body: payload.body.trim(),
        },
        update: {
            channel: "EMAIL",
            subject: payload.subject?.trim() || null,
            body: payload.body.trim(),
        },
    });
};

const deleteTemplate = async (user: IRequestUser, key: string) => {
    assertTemplateKey(key);
    const adminId = await resolveAdminId(user);
    await prisma.notificationTemplate.deleteMany({ where: { adminId, key } });
    return { reset: true };
};


// ─── Item 18: In-app notification inbox service methods ───────────────────────


const getInbox = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user);
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

const markRead = async (user: IRequestUser, notificationId: string) => {
    const adminId = await resolveAdminId(user);
    await prisma.notification.updateMany({
        where: { id: notificationId, adminId },
        data: { isRead: true },
    });
    await redis.del(`notifications:${adminId}`).catch(() => {});
};

const markAllRead = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user);
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
        logger.warn(`[NOTIFICATION SERVICE] Failed to fetch preferences for admin ${adminId}, defaulting to true: ${String(err)}`);
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
    getTemplates,
    upsertTemplate,
    deleteTemplate,
};
