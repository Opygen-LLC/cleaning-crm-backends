import { assertAuthSecurityConfiguration, assertProcessRole } from "../config/authSecurity";
import { assertInfrastructureAlignment } from "../lib/monitoring/infrastructure";
import logger from "../lib/logger";
import { startEmailOutboxWorker, stopEmailOutboxWorker } from "../workers/emailOutbox.worker";
import { prisma } from "../lib/prisma/prisma";
import redis from "../config/redis";

async function main() {
    assertProcessRole("worker");
    assertAuthSecurityConfiguration();
    assertInfrastructureAlignment();
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
