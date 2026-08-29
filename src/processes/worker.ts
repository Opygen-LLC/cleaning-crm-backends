import { assertAuthSecurityConfiguration, assertProcessRole } from "../config/authSecurity";
import { assertRuntimeEnvironment } from "../config/runtimeEnv";
import { assertInfrastructureAlignment } from "../lib/monitoring/infrastructure";
import { SMTP_VERIFY_ON_STARTUP } from "../config/ENV";
import { verifyEmailTransport } from "../lib/email";
import logger from "../lib/logger";
import { startEmailOutboxWorker, stopEmailOutboxWorker } from "../workers/emailOutbox.worker";
import { prisma } from "../lib/prisma/prisma";
import redis from "../config/redis";

async function main() {
    assertProcessRole("worker");
    assertRuntimeEnvironment();
    assertAuthSecurityConfiguration();
    assertInfrastructureAlignment();
    if (SMTP_VERIFY_ON_STARTUP) {
        try {
            await verifyEmailTransport();
        } catch (error) {
            // Do not take down unrelated durable jobs (for example public-site
            // cache revalidation) just because SMTP is temporarily unavailable.
            // Email outbox rows remain pending/retryable and will be delivered
            // after SMTP recovers.
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Worker started with email delivery unavailable — ${message}`);
        }
    }
    startEmailOutboxWorker();
    logger.info("Worker process started");

    const shutdown = async (signal: string) => {
        logger.info(`${signal} received; stopping worker`);
        stopEmailOutboxWorker();
        await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
        process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch((error) => {
    logger.error("Worker startup failed", error);
    process.exit(1);
});
