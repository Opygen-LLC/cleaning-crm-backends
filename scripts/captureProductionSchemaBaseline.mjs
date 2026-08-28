import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to capture the production schema baseline.");
  process.exit(1);
}

const outDir = resolve(process.env.SCHEMA_BASELINE_DIR || "release-artifacts");
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const run = (args) => {
  const result = spawnSync("pnpm", ["exec", "prisma", ...args], {
    cwd: process.cwd(), env: process.env, encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
};

const pull = run(["db", "pull", "--print"]);
if (pull.status !== 0) {
  process.stderr.write(pull.stderr || pull.stdout);
  process.exit(pull.status || 1);
}
const schema = pull.stdout;
const schemaHash = createHash("sha256").update(schema).digest("hex");
await writeFile(resolve(outDir, `pre-migration-schema-${stamp}.prisma`), schema, "utf8");

const diff = run(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema", "--script"]);
if (diff.status !== 0) {
  process.stderr.write(diff.stderr || diff.stdout);
  process.exit(diff.status || 1);
}
await writeFile(resolve(outDir, `pre-migration-diff-${stamp}.sql`), diff.stdout, "utf8");

const status = run(["migrate", "status"]);
await writeFile(resolve(outDir, `pre-migration-status-${stamp}.txt`), `${status.stdout}\n${status.stderr}`, "utf8");

await writeFile(resolve(outDir, `pre-migration-baseline-${stamp}.json`), JSON.stringify({
  capturedAt: new Date().toISOString(),
  schemaSha256: schemaHash,
  migrateStatusExitCode: status.status,
  note: "Schema metadata only. No customer table rows or DATABASE_URL are stored.",
}, null, 2) + "\n", "utf8");

console.log(`Production schema baseline captured. schemaSha256=${schemaHash}`);
