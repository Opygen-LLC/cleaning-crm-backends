import Redis from "ioredis";
import { OUTBOX_WORKER_POLL_MS } from "../config/ENV";

const HEARTBEAT_KEY = "ops:email-outbox-worker:heartbeat:v1";
const freshnessMs = Math.max(30_000, OUTBOX_WORKER_POLL_MS * 6);

async function main() {
    const redis = new Redis({
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: Number(process.env.REDIS_DB) || 0,
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 1_500,
        commandTimeout: 1_000,
    });
    redis.on("error", () => undefined);

    try {
        const raw = await redis.get(HEARTBEAT_KEY);
        if (!raw) process.exitCode = 1;
        else {
            const parsed = JSON.parse(raw) as { at?: unknown; processRole?: unknown };
            const at = typeof parsed.at === "string" ? new Date(parsed.at) : null;
            const age = at && Number.isFinite(at.getTime()) ? Date.now() - at.getTime() : Number.POSITIVE_INFINITY;
            process.exitCode = parsed.processRole === "worker" && age >= 0 && age <= freshnessMs ? 0 : 1;
        }
    } catch {
        process.exitCode = 1;
    } finally {
        redis.disconnect();
    }
}

void main();
