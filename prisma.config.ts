import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma CLI operations need a session-preserving direct Neon connection.
// Runtime application queries continue to use DATABASE_URL through the pg
// driver adapter in src/lib/prisma/prisma.ts.
const cliDatabaseUrl =
  process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  ...(cliDatabaseUrl
    ? { datasource: { url: cliDatabaseUrl } }
    : {}),
});
