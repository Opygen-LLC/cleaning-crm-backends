import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

/**
 * Read-only plan audit for hot tenant-scoped SQL shapes.
 * All values remain Prisma parameters; no application input is concatenated
 * into executable SQL.
 */
const adminId = process.env.PERF_ADMIN_ID?.trim();
const targetMs = Math.max(1, Number(process.env.PERF_DB_TARGET_MS ?? 30));
if (!adminId) throw new Error("PERF_ADMIN_ID is required for the Phase 4 EXPLAIN probe");

type Probe = { name: string; sql: Prisma.Sql };
const probes: Probe[] = [
  {
    name: "auth-active-session",
    sql: Prisma.sql`SELECT s.id, s."expiresAt"
      FROM "session" s
      WHERE s."userId" = (SELECT ap."userId" FROM "AdminProfile" ap WHERE ap.id = ${adminId})
        AND s."expiresAt" > NOW()
      ORDER BY s."createdAt" DESC
      LIMIT 3`,
  },
  {
    name: "invoice-paid-period",
    sql: Prisma.sql`SELECT COALESCE(SUM(i.total), 0)
      FROM "invoice" i
      WHERE i."adminId" = ${adminId} AND i.status = 'PAID'
        AND i."paidDate" >= NOW() - INTERVAL '30 days'`,
  },
  {
    name: "expense-period",
    sql: Prisma.sql`SELECT COALESCE(SUM(e.amount), 0)
      FROM "expense" e
      WHERE e."adminId" = ${adminId}
        AND e.date >= NOW() - INTERVAL '30 days'`,
  },
  {
    name: "booking-status-schedule",
    sql: Prisma.sql`SELECT b.id, b."scheduledDate"
      FROM "booking" b
      WHERE b."adminId" = ${adminId} AND b.status = 'SCHEDULED'
      ORDER BY b."scheduledDate" DESC, b.id DESC
      LIMIT 50`,
  },
  {
    name: "lead-stage-newest",
    sql: Prisma.sql`SELECT l.id, l."createdAt"
      FROM "lead" l
      WHERE l."adminId" = ${adminId} AND l.stage = 'NEW'
      ORDER BY l."createdAt" DESC, l.id DESC
      LIMIT 50`,
  },
  {
    name: "website-owner-row",
    sql: Prisma.sql`SELECT bw.id, bw.status, bw."updatedAt"
      FROM "business_website" bw
      WHERE bw."adminId" = ${adminId}
      LIMIT 1`,
  },
  {
    name: "active-subscription",
    sql: Prisma.sql`SELECT s.id
      FROM "Subscription" s
      WHERE s."adminId" = ${adminId} AND s.status = 'ACTIVE'
      LIMIT 1`,
  },
];

const findNodeTypes = (node: unknown, output = new Set<string>()): Set<string> => {
  if (!node || typeof node !== "object") return output;
  const record = node as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") output.add(record["Node Type"]);
  const plans = record.Plans;
  if (Array.isArray(plans)) plans.forEach((child) => findNodeTypes(child, output));
  return output;
};

let failed = false;
try {
  for (const probe of probes) {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe.sql}`,
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

if (failed) throw new Error(`One or more Phase 4 DB probes exceeded ${targetMs}ms`);
