import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const directUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!directUrl) {
  console.error("DIRECT_URL or DATABASE_URL must be provided.");
  process.exit(1);
}

const client = new Client({ connectionString: directUrl });

async function run() {
  await client.connect();
  console.log("Connected to PostgreSQL database successfully.");

  // 1. Ensure _prisma_migrations exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log("Verified _prisma_migrations table.");

  // Fetch already recorded migrations
  const existingRes = await client.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  const recorded = new Set(existingRes.rows.map(r => r.migration_name));

  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const entries = readdirSync(migrationsDir)
    .filter(name => statSync(join(migrationsDir, name)).isDirectory())
    .sort();

  console.log(`Found ${entries.length} migrations in prisma/migrations.`);

  const r2Migrations = [
    "20260910170000_r2_media_foundation",
    "20260910193000_r2_phase2_domain_media_references",
    "20260910200000_r2_phase3_hardening",
  ];

  // 2. Execute the R2 migration SQLs in order
  for (const name of r2Migrations) {
    if (recorded.has(name)) {
      console.log(`Migration ${name} already recorded, skipping execution.`);
      continue;
    }
    const sqlPath = join(migrationsDir, name, "migration.sql");
    const sql = readFileSync(sqlPath, "utf8");
    console.log(`Applying SQL for ${name}...`);
    await client.query(sql);
    console.log(`Applied SQL for ${name} successfully.`);
  }

  // 3. Record all migrations in _prisma_migrations with exact sha256 checksums
  for (const name of entries) {
    if (recorded.has(name)) continue;

    const sqlPath = join(migrationsDir, name, "migration.sql");
    const sql = readFileSync(sqlPath, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    await client.query(`
      INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "started_at", "applied_steps_count")
      VALUES ($1, $2, now(), $3, NULL, now(), 1)
      ON CONFLICT ("id") DO NOTHING
    `, [randomUUID(), checksum, name]);
    console.log(`Recorded migration ${name} in _prisma_migrations.`);
  }

  await client.end();
  console.log("All migrations applied and recorded successfully!");
}

run().catch(err => {
  console.error("Migration script failed:", err);
  process.exit(1);
});
