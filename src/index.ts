import http from "http";
import { BACKEND_IP, PORT } from "./config/ENV";
import { assertAuthSecurityConfiguration, assertProcessRole } from "./config/authSecurity";
import setUpSocketIO from "./config/socketio";
import app from "./server";
import logger from "./lib/logger";
import { ErrorMonitor } from "./lib/monitoring/errorMonitor";
import { assertInfrastructureAlignment, getInfrastructureAlignment } from "./lib/monitoring/infrastructure";
import { assertWebsitePlatformConfiguration } from "./modules/Website/websitePlatformConfig";

const installFatalHandlers = () => {
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`Unhandled rejection: ${error.stack ?? error.message}`);
    void ErrorMonitor.captureBackendError({ message: error.message, stack: error.stack ?? null, code: "UNHANDLED_REJECTION" });
  });
  process.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception: ${error.stack ?? error.message}`);
    void ErrorMonitor.captureBackendError({ message: error.message, stack: error.stack ?? null, code: "UNCAUGHT_EXCEPTION" });
    process.exitCode = 1;
    const timer = setTimeout(() => process.exit(1), 250);
    timer.unref();
  });
};

const main = () => {
  installFatalHandlers();
  assertProcessRole("api");
  assertAuthSecurityConfiguration();
  assertWebsitePlatformConfiguration();
  assertInfrastructureAlignment();

  const infra = getInfrastructureAlignment();
  if (infra.known) {
    logger.info(
      `Infrastructure topology — ${infra.deploymentProfile} · primary ${infra.primaryRegion} · API ${infra.appRegion} · process ${infra.processRegion} · database ${infra.databaseRegion} · Redis ${infra.redisRegion} · ${infra.aligned ? "aligned" : "NOT aligned"}.`,
    );
  } else {
    logger.info("Infrastructure region labels are incomplete; production should set PRIMARY_REGION, APP_REGION, DATABASE_REGION and REDIS_REGION before serving traffic.");
  }

  const server = http.createServer(app);
  setUpSocketIO(server);

  const host = BACKEND_IP || "0.0.0.0";
  const port = Number(process.env.PORT || PORT || 5000);
  server.listen(port, host, () => logger.info(`API process listening at http://${host}:${port}`));

  const shutdown = (signal: string) => {
    logger.info(`${signal} received; draining API process`);
    server.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
};

try { main(); } catch (error) {
  logger.error("API startup failed", error);
  process.exit(1);
}
