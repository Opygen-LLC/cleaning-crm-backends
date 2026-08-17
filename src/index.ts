import { PORT } from "./config/ENV";
import setUpSocketIO from "./config/socketio";
import { seedSubscriptionPlans } from "./lib/utils/seedSubscriptionPlan";
import { seedSuperAdmin } from "./lib/utils/seedSuperAdmin";
import app from "./server";
import http from "http";
import logger from "./lib/logger";
import { ErrorMonitor } from "./lib/monitoring/errorMonitor";
import { assertInfrastructureAlignment, getInfrastructureAlignment } from "./lib/monitoring/infrastructure";
import { startEmailOutboxWorker } from "./workers/emailOutbox.worker";


process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled rejection: ${error.stack ?? error.message}`);
  void ErrorMonitor.captureBackendError({ message: error.message, stack: error.stack ?? null, code: "UNHANDLED_REJECTION" });
});

process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception: ${error.stack ?? error.message}`);
  void ErrorMonitor.captureBackendError({ message: error.message, stack: error.stack ?? null, code: "UNCAUGHT_EXCEPTION" });
  // The process may be in an undefined state after an uncaught exception.
  // Give the non-blocking monitor a brief opportunity to flush, then let the
  // platform/process manager restart a clean instance.
  process.exitCode = 1;
  const exitTimer = setTimeout(() => process.exit(1), 250);
  exitTimer.unref();
});

const backendIp = process.env.BACKEND_IP || "0.0.0.0";
const port = process.env.PORT || PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
setUpSocketIO(server);

function main() {
  try {
    assertInfrastructureAlignment();
    const infrastructure = getInfrastructureAlignment();
    logger.info(
      `[INFRA] app=${infrastructure.appRegion ?? "unknown"} db=${infrastructure.databaseRegion ?? "unknown"} redis=${infrastructure.redisRegion ?? "unknown"} aligned=${infrastructure.aligned}`,
    );

    // Seeds are fire-and-forget after listen() to avoid blocking the first
    // request on two DB round-trips during cold-start (especially on Neon).
    // Both seed functions short-circuit when data already exists.
    server.listen(Number(port), backendIp, () => {
      logger.info(`Server is running at http://${backendIp}:${port}`);
      startEmailOutboxWorker();

      seedSuperAdmin().catch((error) => {
        logger.error("Error seeding super admin", error);
      });
      seedSubscriptionPlans().catch((error) => {
        logger.error("Error seeding subscription plans", error);
      });
    });
  } catch (error) {
    logger.error("Error starting the server", error);
    process.exitCode = 1;
  }
}

main();
