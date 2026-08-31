import pg from "pg";

const { Client } = pg;

const REQUIRED_COLUMNS = [
  "lastUsedAt",
  "refreshTokenHash",
  "previousRefreshTokenHash",
  "refreshFamilyId",
  "refreshRotatedAt",
];

const REQUIRED_INDEXES = [
  "session_userId_expiresAt_createdAt_idx",
  "session_refreshFamilyId_idx",
];

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required for auth session schema verification.");
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();

  const [columnResult, indexResult] = await Promise.all([
    client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false))
        AND table_name = 'session'
    `),
    client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = ANY (current_schemas(false))
        AND tablename = 'session'
    `),
  ]);

  const columns = new Set(columnResult.rows.map((row) => row.column_name));
  const indexes = new Set(indexResult.rows.map((row) => row.indexname));
  const missingColumns = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  const missingIndexes = REQUIRED_INDEXES.filter((name) => !indexes.has(name));

  if (missingColumns.length || missingIndexes.length) {
    console.error("Auth session schema verification failed.");
    if (missingColumns.length) {
      console.error(`Missing session columns: ${missingColumns.join(", ")}`);
    }
    if (missingIndexes.length) {
      console.error(`Missing session indexes: ${missingIndexes.join(", ")}`);
    }
    console.error(
      "Deploy Prisma migration 20260828190000_phase5_session_refresh_hardening before serving login traffic.",
    );
    process.exitCode = 2;
  } else {
    console.log(
      "Auth session schema verification passed: Phase 5 refresh-rotation columns and indexes are present.",
    );
  }
} catch (error) {
  console.error(
    "Auth session schema verification could not query PostgreSQL:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
