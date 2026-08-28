import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for schema drift check.");
  process.exit(1);
}

const result = spawnSync("pnpm", [
  "exec", "prisma", "migrate", "diff",
  "--from-config-datasource",
  "--to-schema", "prisma/schema",
  "--script",
], { cwd: process.cwd(), env: process.env, encoding: "utf8" });

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

let sql = result.stdout ?? "";
// These database-native indexes are intentionally managed by migration SQL
// because Prisma schema cannot express pg_trgm opclasses / partial predicates.
const allowedIndexNames = [
  "client_name_trgm_idx",
  "client_email_trgm_idx",
  "booking_form_service_legacy_unique",
  "estimate_form_service_legacy_unique",
];
for (const name of allowedIndexNames) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  sql = sql.replace(new RegExp(`DROP\\s+INDEX(?:\\s+IF\\s+EXISTS)?\\s+\\"?${escaped}\\"?\\s*;?`, "gi"), "");
}
sql = sql
  .replace(/--[^\n]*/g, "")
  .replace(/\s+/g, " ")
  .trim();

if (sql) {
  console.error("Schema drift detected after migration deploy. Refusing to declare the release healthy.");
  console.error(result.stdout);
  process.exit(2);
}

console.log("Schema drift check passed (database matches Prisma schema; native indexes are allowlisted).");
