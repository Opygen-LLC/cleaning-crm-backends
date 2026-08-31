#!/usr/bin/env node
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for the Phase 1 schema contract check.");
  process.exit(2);
}

const REQUIRED_MIGRATIONS = [
  "20260901021500_phase6_local_draft_seo_ga4",
  "20260901034000_phase1_notification_preference_reliability",
  "20260901052000_phase3_estimate_public_sharing",
];

const REQUIRED_COLUMNS = [
  ["notification_preference", "emailBookingDayOfReminder"],
  ["notification_preference", "emailQuoteSent"],
  ["notification_preference", "emailEstimateSent"],
  ["notification_preference", "emailInvoiceSent"],
  ["notification_preference", "emailReviewRequest"],
  ["business_website", "metaKeywords"],
  ["business_website", "googleAnalyticsEnabled"],
  ["business_website", "googleAnalyticsMeasurementId"],
  ["website_page", "seoKeywords"],
  ["website_page", "socialImageUrl"],
  ["estimate", "publicToken"],
  ["estimate", "respondedAt"],
  ["estimate", "responseNote"],
];

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const schemaResult = await client.query("SELECT current_schema() AS schema");
  const schema = schemaResult.rows[0]?.schema || "public";

  const migrationResult = await client.query(
    `SELECT migration_name, finished_at, rolled_back_at
       FROM "_prisma_migrations"
      WHERE migration_name = ANY($1::text[])`,
    [REQUIRED_MIGRATIONS],
  );
  const applied = new Set(
    migrationResult.rows
      .filter((row) => row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name),
  );
  const missingMigrations = REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));

  const columnResult = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1`,
    [schema],
  );
  const columns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = REQUIRED_COLUMNS
    .map(([table, column]) => `${table}.${column}`)
    .filter((entry) => !columns.has(entry));

  if (missingMigrations.length || missingColumns.length) {
    console.error("Phase 1 schema contract FAILED.");
    if (missingMigrations.length) console.error(`Missing applied migrations: ${missingMigrations.join(", ")}`);
    if (missingColumns.length) console.error(`Missing columns: ${missingColumns.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Phase 1 schema contract passed: required migrations and columns are present.");
  }
} catch (error) {
  console.error(`Phase 1 schema contract FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
