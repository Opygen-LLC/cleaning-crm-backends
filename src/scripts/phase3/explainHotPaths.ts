import { prisma } from "../../lib/prisma/prisma";

/**
 * Read-only Phase 3 database plan probe.
 *
 * Usage:
 *   PERF_ADMIN_ID=<admin-id> PERF_DB_TARGET_MS=30 pnpm perf:phase3:explain
 *
 * EXPLAIN ANALYZE executes the SELECT statements, but never mutates data.
 * Run against a production-like replica first; use production only during a
 * controlled low-traffic window.
 */
const adminId = process.env.PERF_ADMIN_ID?.trim();
const targetMs = Math.max(1, Number(process.env.PERF_DB_TARGET_MS ?? 30));

if (!adminId) {
  throw new Error("PERF_ADMIN_ID is required for the Phase 3 EXPLAIN probe");
}

type Probe = { name: string; sql: string };
const probes: Probe[] = [
  {
    name: "website-editor-owner-row",
    sql: `SELECT id, "draftRevisionNumber", "publishedRevisionNumber", "updatedAt"
          FROM "business_website"
          WHERE "adminId" = $1
          LIMIT 1`,
  },
  {
    name: "clients-newest",
    sql: `SELECT id, "createdAt" FROM "client"
          WHERE "adminId" = $1
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 50`,
  },
  {
    name: "leads-newest",
    sql: `SELECT id, "createdAt" FROM "lead"
          WHERE "adminId" = $1
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 50`,
  },
  {
    name: "bookings-scheduled",
    sql: `SELECT id, "scheduledDate" FROM "booking"
          WHERE "adminId" = $1
          ORDER BY "scheduledDate" DESC, id DESC
          LIMIT 50`,
  },
  {
    name: "jobs-scheduled",
    sql: `SELECT id, "scheduledDate" FROM "job"
          WHERE "adminId" = $1
          ORDER BY "scheduledDate" DESC, id DESC
          LIMIT 50`,
  },
];

const findNodeTypes = (node: unknown, output = new Set<string>()): Set<string> => {
  if (!node || typeof node !== "object") return output;
  const record = node as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") output.add(record["Node Type"] as string);
  const plans = record.Plans;
  if (Array.isArray(plans)) plans.forEach((child) => findNodeTypes(child, output));
  return output;
};

let failed = false;
try {
  for (const probe of probes) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe.sql}`,
      adminId,
    );
    const payload = rows[0]?.["QUERY PLAN"] as Array<Record<string, unknown>> | undefined;
    const plan = payload?.[0];
    const executionMs = Number(plan?.["Execution Time"] ?? 0);
    const nodeTypes = [...findNodeTypes(plan?.Plan)].join(", ");
    const overTarget = executionMs > targetMs;
    failed ||= overTarget;
    console.log(`${overTarget ? "FAIL" : "PASS"} ${probe.name}: ${executionMs.toFixed(2)}ms [${nodeTypes || "unknown plan"}]`);
  }
} finally {
  await prisma.$disconnect();
}

if (failed) {
  throw new Error(`One or more hot-path DB probes exceeded ${targetMs}ms`);
}
