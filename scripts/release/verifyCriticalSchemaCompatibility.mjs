#!/usr/bin/env node
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for the critical schema compatibility gate.");
  process.exit(2);
}

const REQUIRED_MIGRATIONS = [
  "20260901021500_phase6_local_draft_seo_ga4",
  "20260901034000_phase1_notification_preference_reliability",
  "20260901052000_phase3_estimate_public_sharing",
  "20260901124500_phase2_atomic_public_document_publication",
  "20260901153000_phase3_unified_website_submissions",
  "20260901193000_phase4_company_service_reviews",
];

// Explicit production contract for the models whose shape is required by
// authentication, notifications, Website Studio/public rendering and public
// quote/estimate sharing. `prisma migrate diff` still runs separately as the
// whole-schema drift gate; this gives a fast, readable failure before deploy.
const REQUIRED_COLUMNS = {
  notification_preference: [
    "adminId",
    "emailBookingDayOfReminder",
    "emailQuoteSent",
    "emailEstimateSent",
    "emailInvoiceSent",
    "emailReviewRequest",
  ],
  business_website: [
    "id",
    "adminId",
    "subdomain",
    "status",
    "publishedSnapshot",
    "metaKeywords",
    "googleAnalyticsEnabled",
    "googleAnalyticsMeasurementId",
  ],
  website_page: ["id", "websiteId", "slug", "seoKeywords", "socialImageUrl"],
  quote: ["id", "adminId", "publicToken", "publishedAt", "sentAt", "respondedAt", "responseNote"],
  estimate: ["id", "adminId", "publicToken", "publishedAt", "sentAt", "respondedAt", "responseNote"],
  service_catalog: ["id", "adminId", "serviceName", "slug"],
  review: ["id", "adminId", "reviewTokenId", "jobId", "scope", "source", "serviceCatalogId", "serviceNameSnapshot", "websiteId"],
  website_review_contact: ["id", "reviewId", "adminId", "websiteId", "email", "phone", "submissionKeyHash"],
  session: [
    "id",
    "userId",
    "token",
    "refreshTokenHash",
    "previousRefreshTokenHash",
    "refreshFamilyId",
    "refreshRotatedAt",
  ],
  AdminProfile: [
    "id",
    "userId",
    "businessName",
    "businessLogo",
    "brandColor",
    "onboardingCompletedSteps",
    "onboardingCompletedAt",
  ],
};

const REQUIRED_INDEXES = [
  ["quote", "quote_publicToken_key"],
  ["estimate", "estimate_publicToken_key"],
  ["service_catalog", "service_catalog_adminId_slug_key"],
  ["review", "review_adminId_scope_source_createdAt_idx"],
  ["website_review_contact", "website_review_contact_reviewId_key"],
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

  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const columnResult = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])`,
    [schema, tableNames],
  );
  const actualColumns = new Set(
    columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
    columns
      .map((column) => `${table}.${column}`)
      .filter((key) => !actualColumns.has(key)),
  );

  const indexResult = await client.query(
    `SELECT tablename, indexname
       FROM pg_indexes
      WHERE schemaname = $1
        AND tablename = ANY($2::text[])`,
    [schema, [...new Set(REQUIRED_INDEXES.map(([table]) => table))]],
  );
  const actualIndexes = new Set(
    indexResult.rows.map((row) => `${row.tablename}.${row.indexname}`),
  );
  const missingIndexes = REQUIRED_INDEXES
    .map(([table, index]) => `${table}.${index}`)
    .filter((key) => !actualIndexes.has(key));

  if (missingMigrations.length || missingColumns.length || missingIndexes.length) {
    console.error("Critical Prisma/database schema compatibility FAILED.");
    if (missingMigrations.length) console.error(`Missing migrations: ${missingMigrations.join(", ")}`);
    if (missingColumns.length) console.error(`Missing columns: ${missingColumns.join(", ")}`);
    if (missingIndexes.length) console.error(`Missing indexes: ${missingIndexes.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Critical Prisma/database schema compatibility passed for NotificationPreference, BusinessWebsite, WebsitePage, Quote, Estimate, ServiceCatalog, Review, WebsiteReviewContact, Session and AdminProfile.",
    );
  }
} catch (error) {
  console.error(
    `Critical schema compatibility FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
