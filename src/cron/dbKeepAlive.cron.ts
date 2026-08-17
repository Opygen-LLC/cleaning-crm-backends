import cron from "node-cron";
import { prisma } from "../lib/prisma/prisma";
import { fail } from "./index.cron";
import { DB_KEEPALIVE_CRON, DB_KEEPALIVE_ENABLED } from "../config/ENV";

/**
 * Keeps serverless Postgres compute warm when the selected production plan
 * uses auto-suspend. The interval is configurable because a colocated,
 * always-on database does not need an aggressive ping loop.
 */
if (DB_KEEPALIVE_ENABLED) {
    if (!cron.validate(DB_KEEPALIVE_CRON)) {
        throw new Error(`Invalid DB_KEEPALIVE_CRON expression: ${DB_KEEPALIVE_CRON}`);
    }

    cron.schedule(DB_KEEPALIVE_CRON, async () => {
        try {
            await prisma.$queryRaw`SELECT 1`;
        } catch (err) {
            // /health is the authoritative availability signal. Avoid noisy
            // success logs; only surface failures here.
            fail("dbKeepAlive", err);
        }
    });
}
