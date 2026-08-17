// src/cron/subscriptionExpiry.cron.ts
//
// ─── Item 10: Subscription + trial expiry cron ───────────────────────────────
//
// Runs daily at 00:05 UTC.
// Sets EXPIRED on any ACTIVE (non-trial) subscription where currentPeriodEnd < now.
// Sets EXPIRED on any trial subscription where trialEndsAt < now.
//
// Registration — add to src/server.ts (or wherever your other crons live):
//
//   import { scheduleSubscriptionExpiryJob } from "./cron/subscriptionExpiry.cron";
//   scheduleSubscriptionExpiryJob();
// ---------------------------------------------------------------------------

import cron from "node-cron";
import { prisma } from "../lib/prisma/prisma";
import { log, fail } from "./index.cron";
import { createNotification } from "../lib/utils/createNotification";
import { NotificationType } from "../generated/prisma/enums";
import { invalidateSubscriptionAccessCache } from "../middlewares/checkSubscription";

const JOB_NAME = "subscriptionExpiry";

// Exported (in addition to the schedule wrapper below) so tests can invoke
// the job's logic directly and assert on the resulting prisma calls /
// notifications, rather than only through the fire-and-forget
// cron.schedule(...) callback which swallows its own promise via .catch().
export async function runSubscriptionExpiryJob(): Promise<void> {
    const now = new Date();

    // ── 1. Expire paid subscriptions whose billing period has ended ─────────────
    // BUGFIX: previously a blind updateMany(). Switched to findMany + updateMany
    // so we have each affected adminId in hand — approvePaymentProof,
    // rejectPaymentProof and refundBillingRecord all push a live "subscription"
    // notification via createNotification() so the tenant's sidebar/feature-gates
    // update without a re-login (see useSocketJobStatus.ts's notification:new
    // handler). This cron was the one place that changed `status` silently, so
    // an admin with the dashboard open when their period lapsed saw no lock
    // until their next API call happened to 402.
    const paidToExpire = await prisma.subscription.findMany({
        where: {
            status: "ACTIVE",
            isTrial: false,
            currentPeriodEnd: { lt: now },
        },
        select: { id: true, adminId: true, admin: { select: { userId: true } } },
    });

    if (paidToExpire.length > 0) {
        await prisma.subscription.updateMany({
            where: { id: { in: paidToExpire.map((s) => s.id) } },
            data: { status: "EXPIRED" },
        });

        for (const { id, adminId, admin } of paidToExpire) {
            createNotification({
                adminId,
                type: NotificationType.SUBSCRIPTION,
                title: "Subscription expired",
                message:
                    "Your billing period has ended and your subscription has expired. Renew to restore access.",
                relatedId: id,
            }).catch(() => {});
            await invalidateSubscriptionAccessCache(admin.userId);
        }
    }

    // ── 2. Expire trials whose trial window has ended ───────────────────────────
    const trialsToExpire = await prisma.subscription.findMany({
        where: {
            status: "ACTIVE",
            isTrial: true,
            trialEndsAt: { lt: now },
        },
        select: { id: true, adminId: true, admin: { select: { userId: true } } },
    });

    if (trialsToExpire.length > 0) {
        await prisma.subscription.updateMany({
            where: { id: { in: trialsToExpire.map((s) => s.id) } },
            data: { status: "EXPIRED" },
        });

        for (const { id, adminId, admin } of trialsToExpire) {
            createNotification({
                adminId,
                type: NotificationType.SUBSCRIPTION,
                title: "Free trial ended",
                message:
                    "Your free trial has ended. Upgrade to a paid plan to keep using the platform.",
                relatedId: id,
            }).catch(() => {});
            await invalidateSubscriptionAccessCache(admin.userId);
        }
    }

    const total = paidToExpire.length + trialsToExpire.length;

    if (total > 0) {
        log(
            `${JOB_NAME}: expired ${paidToExpire.length} paid subscription(s) and ${trialsToExpire.length} trial(s).`,
        );
    } else {
        log(`${JOB_NAME}: no subscriptions to expire.`);
    }
}

/**
 * Call once at server startup.
 * Schedule: every day at 00:05 UTC.
 */
export function scheduleSubscriptionExpiryJob(): void {
    // Run immediately on startup (catches anything that expired while server was down)
    runSubscriptionExpiryJob().catch((err) => fail(JOB_NAME, err));

    // Then schedule daily at 00:05 UTC
    cron.schedule("5 0 * * *", () => {
        runSubscriptionExpiryJob().catch((err) => fail(JOB_NAME, err));
    });

    log(`${JOB_NAME}: scheduled (daily at 00:05 UTC).`);
}
