import cron from "node-cron";
import { subDays } from "date-fns";
import { WEBSITE_ANALYTICS_RETENTION_DAYS } from "../config/ENV";
import logger from "../lib/logger";
import { prisma } from "../lib/prisma/prisma";

// Keep privacy-preserving website analytics bounded. Run once per day at 03:25
// server time; deletion uses the dedicated createdAt index so cleanup remains
// predictable as event volume grows across many tenants.
cron.schedule("25 3 * * *", async () => {
  try {
    const cutoff = subDays(new Date(), WEBSITE_ANALYTICS_RETENTION_DAYS);
    const result = await prisma.websiteAnalyticsEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (result.count > 0) logger.info(`Website analytics retention removed ${result.count} expired events.`);
  } catch (error) {
    logger.error(`Website analytics retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
