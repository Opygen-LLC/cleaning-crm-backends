import { assertAuthSecurityConfiguration, assertProcessRole } from "../config/authSecurity";
import { assertRuntimeEnvironment } from "../config/runtimeEnv";
import { assertInfrastructureAlignment } from "../lib/monitoring/infrastructure";
import logger from "../lib/logger";

async function main() {
    assertProcessRole("scheduler");
    assertRuntimeEnvironment();
    assertAuthSecurityConfiguration();
    assertInfrastructureAlignment();

    // Import cron modules only after the process-role guard succeeds. Importing a
    // cron module registers its schedule as a side effect, so static imports
    // would weaken API/worker/scheduler isolation.
    const { scheduleSubscriptionExpiryJob } = await import("../cron/subscriptionExpiry.cron");
    await import("../cron/staffStatus.cron");
    await import("../cron/recurringBooking.cron");
    await import("../cron/invoiceOverdue.cron");
    await import("../cron/bookingReminder.cron");
    await import("../cron/dbKeepAlive.cron");
    await import("../cron/websiteAnalyticsRetention.cron");

    scheduleSubscriptionExpiryJob();
    logger.info("Scheduler process started");
}

main().catch((error) => {
    logger.error("Scheduler startup failed", error);
    process.exit(1);
});
