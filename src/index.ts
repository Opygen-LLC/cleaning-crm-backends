import { PORT } from "./config/ENV";
import setUpSocketIO from "./config/socketio";
import { seedSubscriptionPlans } from "./lib/utils/seedSubscriptionPlan";
import { seedSuperAdmin } from "./lib/utils/seedSuperAdmin";
import app from "./server";
import http from "http";
import logger from "./lib/logger";

const backendIp = process.env.BACKEND_IP || "0.0.0.0";
const port = process.env.PORT || PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
setUpSocketIO(server);

function main() {
  try {
    // Seeds are fire-and-forget after listen() to avoid blocking the first
    // request on two DB round-trips during cold-start (especially on Neon).
    // Both seed functions short-circuit when data already exists.
    server.listen(Number(port), backendIp, () => {
      logger.info(`Server is running at http://${backendIp}:${port}`);

      seedSuperAdmin().catch((error) => {
        logger.error("Error seeding super admin", error);
      });
      seedSubscriptionPlans().catch((error) => {
        logger.error("Error seeding subscription plans", error);
      });
    });
  } catch (error) {
    logger.error("Error starting the server", error);
  }
}

main();
