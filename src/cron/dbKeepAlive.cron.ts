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
 * PERF FIX (Phase 1, performance audit — interval bug): this used to run
 * every 2 minutes (120s) while the local pg pool's `idleTimeoutMillis` was
 * only 30s (see src/lib/prisma/prisma.ts). That meant the pool was
 * *guaranteed* to have already evicted its connections by the time this
 * cron fired — so the "keep-alive" ping itself paid for a full reconnect
 * across the Mumbai<->Virginia link every single time, instead of reusing a
 * warm one. That's the exact cause of `SELECT 1` logging ~2000ms in
 * production, right next to "[CRON] DB keep-alive ping ok".
 *
 * Now that `idleTimeoutMillis` has been raised to 10 minutes and the pool
 * keeps a `min` of warm connections open (see prisma.ts), this only needs to
 * run often enough to stop those warm connections from ever going idle long
 * enough to be evicted — every 30 seconds comfortably beats the new 10-minute
 * idle timeout with a lot of safety margin, while still being cheap (a
 * `SELECT 1` on an already-warm connection is a single fast round trip, not
 * a fresh handshake).
 *
 * NOTE: this reduces cold starts but does not eliminate them entirely
 * (e.g. overnight low-traffic windows, or if the interval is later widened
 * past idleTimeoutMillis again). For a fully-eliminated cold start, disable
 * auto-suspend on the Neon production branch — see Phase 0 of the
 * performance audit for details.
 */
cron.schedule("*/30 * * * * *", async () => {
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
