import { spawnSync } from "node:child_process";

const run = (args, { allowNonZero = false } = {}) => {
  const result = spawnSync("pnpm", ["exec", "prisma", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (!allowNonZero && result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  return result;
};

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for migration preflight.");
  process.exit(1);
}

// This is read-only: Prisma computes the SQL needed to make the live database
// match the checked-in schema. We inspect it; we NEVER execute this generated SQL.
const diff = run([
  "migrate", "diff",
  "--from-config-datasource",
  "--to-schema", "prisma/schema",
  "--script",
]);
const sql = diff.stdout ?? "";

const destructive = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDROP\s+TYPE\b/i,
].filter((pattern) => pattern.test(sql));

if (destructive.length) {
  console.error("Migration preflight refused the release: the live→schema diff contains destructive operations.");
  console.error(sql);
  process.exit(2);
}

console.log("Migration preflight passed: no DROP TABLE, DROP COLUMN, DROP TYPE or TRUNCATE is required.");
