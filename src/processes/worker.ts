import { assertAuthSecurityConfiguration, assertProcessRole } from "../config/authSecurity";
import { assertRuntimeEnvironment } from "../config/runtimeEnv";
import { assertInfrastructureAlignment } from "../lib/monitoring/infrastructure";
import {
    SMTP_HEALTHCHECK_INTERVAL_MS,
    SMTP_VERIFY_ON_STARTUP,
} from "../config/ENV";
import { verifyEmailTransport } from "../lib/email";
import logger from "../lib/logger";
import { startEmailOutboxWorker, stopEmailOutboxWorker } from "../workers/emailOutbox.worker";
import { prisma } from "../lib/prisma/prisma";
import redis from "../config/redis";
import { recordSmtpTransportHealth } from "../lib/monitoring/emailOutboxHealth";

let smtpHealthTimer: NodeJS.Timeout | null = null;
let smtpHealthCheckRunning = false;

const checkSmtpTransport = async (logSuccess = false): Promise<void> => {
    if (smtpHealthCheckRunning) return;
    smtpHealthCheckRunning = true;
    try {
        await verifyEmailTransport({ logSuccess });
        await recordSmtpTransportHealth(true).catch(() => undefined);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordSmtpTransportHealth(false, message).catch(() => undefined);
        // SMTP outages must not take down public-site cache and notification
        // outbox processing. The queue remains durable and retries delivery.
        logger.error(`Worker email transport check failed — ${message}`);
    } finally {
        smtpHealthCheckRunning = false;
    }
};

async function main() {
    assertProcessRole("worker");
    assertRuntimeEnvironment();
    assertAuthSecurityConfiguration();
    assertInfrastructureAlignment();

    if (SMTP_VERIFY_ON_STARTUP) {
        await checkSmtpTransport(true);
        smtpHealthTimer = setInterval(
            () => void checkSmtpTransport(false),
            SMTP_HEALTHCHECK_INTERVAL_MS,
        );
        // The durable outbox timer is the worker's primary lifecycle owner; the
        // SMTP verifier should not keep a broken/disabled worker alive by itself.
        smtpHealthTimer.unref();
    }

    startEmailOutboxWorker();
    logger.info("Worker process started");

    const shutdown = async (signal: string) => {
        logger.info(`${signal} received; stopping worker`);
        if (smtpHealthTimer) {
            clearInterval(smtpHealthTimer);
            smtpHealthTimer = null;
        }
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
