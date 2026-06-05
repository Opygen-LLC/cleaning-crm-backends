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

const JOB_NAME = "subscriptionExpiry";

async function runSubscriptionExpiryJob(): Promise<void> {
  const now = new Date();

  // ── 1. Expire paid subscriptions whose billing period has ended ─────────────
  const expiredPaid = await prisma.subscription.updateMany({
    where: {
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: { lt: now },
    },
    data: { status: "EXPIRED" },
  });

  // ── 2. Expire trials whose trial window has ended ───────────────────────────
  const expiredTrials = await prisma.subscription.updateMany({
    where: {
      status: "ACTIVE",
      isTrial: true,
      trialEndsAt: { lt: now },
    },
    data: { status: "EXPIRED" },
  });

  const total = expiredPaid.count + expiredTrials.count;

  if (total > 0) {
    log(
      `${JOB_NAME}: expired ${expiredPaid.count} paid subscription(s) and ${expiredTrials.count} trial(s).`,
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
