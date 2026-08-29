import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

/** Read-only legacy performance probe retained for compatibility. */
const adminId = process.env.PERF_ADMIN_ID?.trim();
const targetMs = Math.max(1, Number(process.env.PERF_DB_TARGET_MS ?? 30));
if (!adminId) throw new Error("PERF_ADMIN_ID is required for the Phase 3 EXPLAIN probe");

type Probe = { name: string; sql: Prisma.Sql };
const probes: Probe[] = [
  { name: "website-editor-owner-row", sql: Prisma.sql`SELECT id, "draftRevisionNumber", "publishedRevisionNumber", "updatedAt" FROM "business_website" WHERE "adminId" = ${adminId} LIMIT 1` },
  { name: "clients-newest", sql: Prisma.sql`SELECT id, "createdAt" FROM "client" WHERE "adminId" = ${adminId} ORDER BY "createdAt" DESC, id DESC LIMIT 50` },
  { name: "leads-newest", sql: Prisma.sql`SELECT id, "createdAt" FROM "lead" WHERE "adminId" = ${adminId} ORDER BY "createdAt" DESC, id DESC LIMIT 50` },
  { name: "bookings-scheduled", sql: Prisma.sql`SELECT id, "scheduledDate" FROM "booking" WHERE "adminId" = ${adminId} ORDER BY "scheduledDate" DESC, id DESC LIMIT 50` },
  { name: "jobs-scheduled", sql: Prisma.sql`SELECT id, "scheduledDate" FROM "job" WHERE "adminId" = ${adminId} ORDER BY "scheduledDate" DESC, id DESC LIMIT 50` },
];

const findNodeTypes = (node: unknown, output = new Set<string>()): Set<string> => {
  if (!node || typeof node !== "object") return output;
  const record = node as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") output.add(record["Node Type"]);
  if (Array.isArray(record.Plans)) record.Plans.forEach((child) => findNodeTypes(child, output));
  return output;
};

let failed = false;
try {
  for (const probe of probes) {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe.sql}`);
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
if (failed) throw new Error(`One or more hot-path DB probes exceeded ${targetMs}ms`);
