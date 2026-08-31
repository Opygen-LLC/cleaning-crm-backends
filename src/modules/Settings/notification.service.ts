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
import {
    BUSINESS_NOTIFICATION_TEMPLATE_KEYS,
    BUSINESS_NOTIFICATION_REGISTRY,
    type BusinessNotificationTemplateKey,
} from "../../lib/notifications/businessNotificationRegistry";

export const CUSTOMISABLE_TEMPLATE_KEYS = BUSINESS_NOTIFICATION_TEMPLATE_KEYS;

const assertTemplateKey = (key: string) => {
    if (!CUSTOMISABLE_TEMPLATE_KEYS.includes(key as BusinessNotificationTemplateKey)) {
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
    const saved = await prisma.notificationTemplate.findMany({
        where: { adminId, key: { in: [...BUSINESS_NOTIFICATION_TEMPLATE_KEYS] } },
    });
    const savedByKey = new Map(saved.map((item) => [item.key, item]));

    return BUSINESS_NOTIFICATION_TEMPLATE_KEYS.map((key) => {
        const definition = BUSINESS_NOTIFICATION_REGISTRY[key];
        const custom = savedByKey.get(key);
        return {
            id: custom?.id,
            key,
            channel: "EMAIL" as const,
            subject: custom?.subject ?? definition.defaultSubject,
            body: custom?.body ?? definition.defaultBody,
            isCustom: Boolean(custom),
            event: definition.event,
            recipient: definition.recipient,
            preferenceKey: definition.preferenceKey,
            availableVariables: [...definition.availableVariables],
            timing: definition.timing,
            retryPolicy: { maxAttempts: definition.maxAttempts },
            updatedAt: custom?.updatedAt ?? null,
        };
    });
};

const upsertTemplate = async (
    user: IRequestUser,
    key: string,
    payload: UpsertNotificationTemplatePayload,
) => {
    assertTemplateKey(key);
    const definition = BUSINESS_NOTIFICATION_REGISTRY[key as BusinessNotificationTemplateKey];
    const tokenPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    const unsupportedFor = (text: string) => {
        const tokens = [...text.matchAll(tokenPattern)]
            .map((match) => match[1] ?? "")
            .filter(Boolean);
        return [...new Set(tokens)].filter((token) => !definition.availableVariables.includes(token));
    };
    const unsupportedSubject = unsupportedFor(payload.subject ?? "");
    const unsupportedBody = unsupportedFor(payload.body);
    if (unsupportedSubject.length || unsupportedBody.length) {
        const first = unsupportedSubject[0] ?? unsupportedBody[0];
        throw new AppError(status.BAD_REQUEST, `Unsupported template variable: {{${first}}}`, {
            code: "INVALID_TEMPLATE_VARIABLE",
            fieldErrors: {
                ...(unsupportedSubject[0] ? { subject: `Unsupported variable {{${unsupportedSubject[0]}}}` } : {}),
                ...(unsupportedBody[0] ? { body: `Unsupported variable {{${unsupportedBody[0]}}}` } : {}),
            },
            retryable: false,
        });
    }
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
