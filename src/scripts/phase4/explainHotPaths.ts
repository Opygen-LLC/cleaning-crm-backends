import { writeFileSync } from "node:fs";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

/**
 * Read-only plan audit for hot tenant-scoped SQL shapes.
 * All values remain Prisma parameters; no application input is concatenated
 * into executable SQL.
 */
const adminId = process.env.PERF_ADMIN_ID?.trim();
const targetMs = Math.max(1, Number(process.env.PERF_DB_TARGET_MS ?? 30));
const enforceTarget = process.env.PERF_DB_ENFORCE !== "false";
const reportPath = process.env.PERF_EXPLAIN_REPORT_PATH?.trim();
if (!adminId) throw new Error("PERF_ADMIN_ID is required for the Phase 4 EXPLAIN probe");

type Probe = { name: string; sql: Prisma.Sql };
const probes: Probe[] = [

  {
    name: "client-list-newest",
    sql: Prisma.sql`SELECT c.id, c.name, c.email, c.status, c."createdAt"
      FROM "client" c
      WHERE c."adminId" = ${adminId}
      ORDER BY c."createdAt" DESC, c.id DESC
      LIMIT 50`,
  },
  {
    name: "staff-list-role",
    sql: Prisma.sql`SELECT sp.id, sp."staffRole", sp.status, sp."userId"
      FROM "StaffProfile" sp
      WHERE sp."adminId" = ${adminId}
      ORDER BY sp."createdAt" DESC, sp.id DESC
      LIMIT 50`,
  },
  {
    name: "followups-due",
    sql: Prisma.sql`SELECT la.id, la."leadId", la."scheduledAt", la.status
      FROM "lead_activity" la
      WHERE la."adminId" = ${adminId} AND la.type = 'FOLLOW_UP' AND la.status = 'PENDING'
        AND la."scheduledAt" IS NOT NULL
      ORDER BY la."scheduledAt" ASC, la.id ASC
      LIMIT 50`,
  },
  {
    name: "payment-list-newest",
    sql: Prisma.sql`SELECT p.id, p."paymentRef", p.status, p.amount, p."createdAt"
      FROM "payment" p
      WHERE p."adminId" = ${adminId}
      ORDER BY p."createdAt" DESC, p.id DESC
      LIMIT 50`,
  },
  {
    name: "invoice-list-newest",
    sql: Prisma.sql`SELECT i.id, i."invoiceRef", i.status, i.total, i."createdAt"
      FROM "invoice" i
      WHERE i."adminId" = ${adminId}
      ORDER BY i."createdAt" DESC, i.id DESC
      LIMIT 50`,
  },
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

type PlanFacts = { nodeTypes: Set<string>; indexes: Set<string>; actualRows: number; planRows: number; sharedReadBlocks: number; sharedHitBlocks: number };
const collectPlanFacts = (node: unknown, facts: PlanFacts = { nodeTypes: new Set(), indexes: new Set(), actualRows: 0, planRows: 0, sharedReadBlocks: 0, sharedHitBlocks: 0 }): PlanFacts => {
  if (!node || typeof node !== "object") return facts;
  const record = node as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") facts.nodeTypes.add(record["Node Type"]);
  if (typeof record["Index Name"] === "string") facts.indexes.add(record["Index Name"]);
  facts.actualRows += Number(record["Actual Rows"] ?? 0);
  facts.planRows += Number(record["Plan Rows"] ?? 0);
  facts.sharedReadBlocks += Number(record["Shared Read Blocks"] ?? 0);
  facts.sharedHitBlocks += Number(record["Shared Hit Blocks"] ?? 0);
  const plans = record.Plans;
  if (Array.isArray(plans)) plans.forEach((child) => collectPlanFacts(child, facts));
  return facts;
};

let failed = false;
const report: Array<Record<string, unknown>> = [];
try {
  for (const probe of probes) {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe.sql}`,
    );
    const payload = rows[0]?.["QUERY PLAN"] as Array<Record<string, unknown>> | undefined;
    const plan = payload?.[0];
    const executionMs = Number(plan?.["Execution Time"] ?? 0);
    const rootPlan = plan?.Plan as Record<string, unknown> | undefined;
    const facts = collectPlanFacts(rootPlan);
    const nodeTypes = [...facts.nodeTypes].join(", ");
    const indexes = [...facts.indexes].join(", ") || "none";
    const rowsReturned = Number(rootPlan?.["Actual Rows"] ?? 0);
    const overTarget = executionMs > targetMs;
    failed ||= enforceTarget && overTarget;
    const rawSql = probe.sql as unknown as { sql?: string; text?: string };
    const queryTemplate = String(rawSql.sql ?? rawSql.text ?? probe.name).replace(/\s+/g, " ").trim();
    const row = {
      result: overTarget ? (enforceTarget ? "FAIL" : "WARN") : "PASS",
      probe: probe.name,
      queryTemplate,
      executionMs: Math.round(executionMs * 100) / 100,
      targetMs,
      rowsScannedAcrossPlan: facts.actualRows,
      rowsReturned,
      plannerRowsAcrossPlan: facts.planRows,
      sharedReadBlocks: facts.sharedReadBlocks,
      sharedHitBlocks: facts.sharedHitBlocks,
      indexes,
      nodeTypes: nodeTypes || "unknown plan",
    };
    report.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  await prisma.$disconnect();
}

if (reportPath) {
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), targetMs, enforceTarget, probes: report }, null, 2));
  console.log(`Phase 4 EXPLAIN report: ${reportPath}`);
}
if (failed) throw new Error(`One or more Phase 4 DB probes exceeded ${targetMs}ms`);
