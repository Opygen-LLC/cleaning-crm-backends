import { PrismaPg } from "@prisma/adapter-pg";
import { DATABASE_URL, DB_POOL_MAX, SLOW_QUERY_THRESHOLD_MS } from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";
import logger from "../logger";

if (!DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Check your .env file — the app cannot start without a database connection string.",
    );
}

const connectionString = DATABASE_URL;

// Neon (and most serverless Postgres providers) can take several seconds to
// wake a suspended compute on the first query after idling, and the `pg`
// driver's default connectionTimeoutMillis is effectively unset / too short
// for that. These options give cold starts room to finish instead of
// failing fast with ETIMEDOUT, while still capping pool size sensibly for
// a serverless-friendly (pooled) connection string.
//
// PERF FIX (Phase 1.2): `max` was previously hardcoded to 10. A single
// dashboard load alone fires 13 parallel queries (see dashboard.service.ts),
// so two admins opening the dashboard at the same moment could already
// exceed a pool of 10, queueing every other in-flight request behind it —
// and with connectionTimeoutMillis at 20s, a starved request would hang for
// up to 20 seconds before failing. `max` is now configurable via
// DB_POOL_MAX (defaults to 10 if unset, matching the previous behaviour) so
// it can be raised to match what the Neon plan/compute size actually
// supports without a code change. Reducing the *number* of queries per
// request (Phase 2 adminId caching, Phase 3 pagination, Phase 4 SQL-side
// aggregation) still matters more than pool size alone — a bigger pool
// just buys headroom while those land.
const adapter = new PrismaPg({
    connectionString,
    max: DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
});

const prisma = new PrismaClient({
    adapter,
    log: [{ level: "query", emit: "event" }],
});

// PERF FIX (Phase 1.3): there was no visibility into query duration before
// this, so "it feels slow" had no concrete numbers to point at. Any query
// over SLOW_QUERY_THRESHOLD_MS (default 300ms) is logged via the existing
// winston logger (not console.warn, so it's captured by the same rotating
// file transport as the rest of the app) — use this to confirm the Phase
// 2–4 fixes actually move the needle, and to catch regressions later.
prisma.$on("query", (e: { query: string; params: string; duration: number }) => {
    if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(`[SLOW QUERY ${e.duration}ms] ${e.query} -- params: ${e.params}`);
    }
});

export { prisma };
