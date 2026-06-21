import { PrismaPg } from "@prisma/adapter-pg";
import { DATABASE_URL } from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";

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
const adapter = new PrismaPg({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
});

const prisma = new PrismaClient({ adapter });

export { prisma };
