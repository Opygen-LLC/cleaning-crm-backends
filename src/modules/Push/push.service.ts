import webPush from "web-push";
import { prisma } from "../../lib/prisma/prisma";
import {
    VAPID_PRIVATE_KEY,
    VAPID_PUBLIC_KEY,
    VAPID_SUBJECT,
} from "../../config/ENV";
import logger from "../../lib/logger";

const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (configured) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

export interface PushPayload {
    title: string;
    body: string;
    url?: string;
    tag?: string;
}

const getPublicKey = () => ({
    publicKey: VAPID_PUBLIC_KEY ?? null,
    configured,
});

const subscribe = async (
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
) => prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
    },
    update: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
    },
});

const unsubscribe = async (userId: string, endpoint: string) => {
    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { unsubscribed: true };
};

export const sendPushToUsers = async (userIds: string[], payload: PushPayload) => {
    if (!configured || userIds.length === 0) return;
    const subscriptions = await prisma.pushSubscription.findMany({
        where: { userId: { in: userIds } },
    });

    await Promise.allSettled(subscriptions.map(async (subscription) => {
        try {
            await webPush.sendNotification(
                {
                    endpoint: subscription.endpoint,
                    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
                },
                JSON.stringify(payload),
            );
        } catch (error: any) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
                await prisma.pushSubscription.delete({ where: { id: subscription.id } });
                return;
            }
            logger.warn(`[PUSH] Delivery failed for subscription ${subscription.id}: ${error?.message ?? error}`);
        }
    }));
};

export const pushService = { getPublicKey, subscribe, unsubscribe };
