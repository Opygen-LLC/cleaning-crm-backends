import { assertAuthSecurityConfiguration, assertProcessRole } from "../config/authSecurity";
import { assertInfrastructureAlignment } from "../lib/monitoring/infrastructure";
import { seedSubscriptionPlans } from "../lib/utils/seedSubscriptionPlan";
import { seedSuperAdmin } from "../lib/utils/seedSuperAdmin";
import { prisma } from "../lib/prisma/prisma";
import logger from "../lib/logger";

async function main() {
    assertProcessRole("bootstrap");
    assertAuthSecurityConfiguration();
    assertInfrastructureAlignment();
    await seedSuperAdmin();
    await seedSubscriptionPlans();
    logger.info("Bootstrap process completed");
}

void main()
    .catch((error) => {
        logger.error("Bootstrap failed", error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
