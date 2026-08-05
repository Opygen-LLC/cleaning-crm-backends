import cron from "node-cron";
import { prisma } from "../lib/prisma/prisma";
import { log, fail } from "./index.cron";

/**
 * dbKeepAlive.cron.ts
 *
 * PERF FIX (Phase 1.1): the production database (Neon Postgres) auto-suspends
 * its compute instance after a period of inactivity. The first query after
 * an idle period has to wait for Neon to resume the compute before it can
 * run — this can take several seconds, and under load can exceed the
 * `pg` driver's connection timeout entirely (see the comments in
 * src/lib/prisma/prisma.ts, which already document this behavior).
 *
 * This was the leading suspected cause of the "sometimes it just doesn't
 * work" reports: a request landing right after an idle period pays the
 * full cold-start cost (or times out), while the next one is instant.
 *
 * Fix: run a trivial, cheap query on a fixed interval short enough to keep
 * Neon's compute from ever suspending during normal operating hours. This
 * runs every 4 minutes — comfortably inside typical serverless-Postgres
 * auto-suspend windows (commonly ~5 minutes) — and does nothing else.
 *
 * NOTE: this reduces cold starts but does not eliminate them entirely
 * (e.g. overnight low-traffic windows, or if the interval is later widened).
 * For a fully-eliminated cold start, upgrade the Neon plan to disable
 * auto-suspend on the production branch — see Phase 1 of the performance
 * audit for details.
 */
cron.schedule("*/4 * * * *", async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
        // Don't let a keep-alive failure look like an app-level incident —
        // just log it. If the DB is genuinely down, /health will already
        // reflect that for uptime monitoring.
        fail("dbKeepAlive", err);
        return;
    }
    log("DB keep-alive ping ok");
});
