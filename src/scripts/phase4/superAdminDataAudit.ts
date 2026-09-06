import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

type CountRow = { count: bigint | number | string };
type AuditFinding = {
  key: string;
  label: string;
  count: number;
  samples: unknown[];
};

const SAMPLE_LIMIT = 20;
const ciMode = process.argv.includes("--ci");
const reportOnly = process.argv.includes("--report-only") || !ciMode;

const toNumber = (value: CountRow["count"] | undefined) => Number(value ?? 0);
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, current) =>
  typeof current === "bigint" ? Number(current) : current,
));

const count = async (tx: Prisma.TransactionClient, sql: Prisma.Sql) => {
  const rows = await tx.$queryRaw<CountRow[]>(sql);
  return toNumber(rows[0]?.count);
};

const samples = async <T>(tx: Prisma.TransactionClient, sql: Prisma.Sql) =>
  tx.$queryRaw<T[]>(sql);

const runAudit = async (): Promise<AuditFinding[]> => prisma.$transaction(async (tx) => {
  // Defense in depth: this script must never repair, delete, or otherwise mutate
  // production data. PostgreSQL will reject any accidental write after this.
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;

  const findings: AuditFinding[] = [];
  const add = async <T>(
    key: string,
    label: string,
    countSql: Prisma.Sql,
    sampleSql: Prisma.Sql,
  ) => {
    findings.push({
      key,
      label,
      count: await count(tx, countSql),
      samples: await samples<T>(tx, sampleSql),
    });
  };

  await add(
    "duplicateServices",
    "Duplicate services by tenant/name (case-insensitive)",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT "adminId", LOWER(BTRIM("serviceName")) AS normalized_name
        FROM "service_catalog"
        GROUP BY "adminId", LOWER(BTRIM("serviceName"))
        HAVING COUNT(*) > 1
      ) duplicates
    `,
    Prisma.sql`
      SELECT "adminId", LOWER(BTRIM("serviceName")) AS "normalizedName", COUNT(*)::int AS count,
             ARRAY_AGG("id" ORDER BY "createdAt") AS ids
      FROM "service_catalog"
      GROUP BY "adminId", LOWER(BTRIM("serviceName"))
      HAVING COUNT(*) > 1
      ORDER BY count DESC, "adminId"
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "servicesWithoutTenant",
    "Services whose adminId has no AdminProfile",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "service_catalog" service
      LEFT JOIN "AdminProfile" tenant ON tenant."id" = service."adminId"
      WHERE tenant."id" IS NULL
    `,
    Prisma.sql`
      SELECT service."id", service."adminId", service."serviceName"
      FROM "service_catalog" service
      LEFT JOIN "AdminProfile" tenant ON tenant."id" = service."adminId"
      WHERE tenant."id" IS NULL
      ORDER BY service."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "crossTenantLeadServices",
    "Leads referencing a ServiceCatalog owned by another tenant",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "lead" lead
      JOIN "service_catalog" service ON service."id" = lead."serviceCatalogId"
      WHERE lead."serviceCatalogId" IS NOT NULL
        AND service."adminId" <> lead."adminId"
    `,
    Prisma.sql`
      SELECT lead."id", lead."leadRef", lead."adminId" AS "leadAdminId",
             lead."serviceCatalogId", service."adminId" AS "serviceAdminId"
      FROM "lead" lead
      JOIN "service_catalog" service ON service."id" = lead."serviceCatalogId"
      WHERE lead."serviceCatalogId" IS NOT NULL
        AND service."adminId" <> lead."adminId"
      ORDER BY lead."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "orphanLeadServiceIds",
    "Leads with a non-null serviceCatalogId whose service no longer exists",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "lead" lead
      LEFT JOIN "service_catalog" service ON service."id" = lead."serviceCatalogId"
      WHERE lead."serviceCatalogId" IS NOT NULL AND service."id" IS NULL
    `,
    Prisma.sql`
      SELECT lead."id", lead."leadRef", lead."adminId", lead."serviceCatalogId"
      FROM "lead" lead
      LEFT JOIN "service_catalog" service ON service."id" = lead."serviceCatalogId"
      WHERE lead."serviceCatalogId" IS NOT NULL AND service."id" IS NULL
      ORDER BY lead."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "orphanSubscriptions",
    "Subscriptions with a missing tenant, Plan, or SubscriptionPlan",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "Subscription" subscription
      LEFT JOIN "AdminProfile" tenant ON tenant."id" = subscription."adminId"
      LEFT JOIN "Plan" plan ON plan."id" = subscription."planId"
      LEFT JOIN "SubscriptionPlan" plan_family ON plan_family."id" = subscription."subscriptionPlanId"
      WHERE tenant."id" IS NULL OR plan."id" IS NULL OR plan_family."id" IS NULL
    `,
    Prisma.sql`
      SELECT subscription."id", subscription."adminId", subscription."planId",
             subscription."subscriptionPlanId", subscription."status"
      FROM "Subscription" subscription
      LEFT JOIN "AdminProfile" tenant ON tenant."id" = subscription."adminId"
      LEFT JOIN "Plan" plan ON plan."id" = subscription."planId"
      LEFT JOIN "SubscriptionPlan" plan_family ON plan_family."id" = subscription."subscriptionPlanId"
      WHERE tenant."id" IS NULL OR plan."id" IS NULL OR plan_family."id" IS NULL
      ORDER BY subscription."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "multipleLiveSubscriptions",
    "Tenants with more than one live subscription",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT "adminId"
        FROM "Subscription"
        WHERE "status" IN ('ACTIVE', 'PENDING_PAYMENT', 'SUSPENDED')
        GROUP BY "adminId"
        HAVING COUNT(*) > 1
      ) duplicates
    `,
    Prisma.sql`
      SELECT "adminId", COUNT(*)::int AS count, ARRAY_AGG("id" ORDER BY "createdAt") AS ids
      FROM "Subscription"
      WHERE "status" IN ('ACTIVE', 'PENDING_PAYMENT', 'SUSPENDED')
      GROUP BY "adminId"
      HAVING COUNT(*) > 1
      ORDER BY count DESC, "adminId"
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "stalePendingPlanChanges",
    "Open PendingPlanChange rows past their expiry",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "PendingPlanChange"
      WHERE "status" IN ('AWAITING_PAYMENT', 'UNDER_REVIEW') AND "expiresAt" < NOW()
    `,
    Prisma.sql`
      SELECT "id", "subscriptionId", "targetPlanId", "status", "expiresAt", "createdAt"
      FROM "PendingPlanChange"
      WHERE "status" IN ('AWAITING_PAYMENT', 'UNDER_REVIEW') AND "expiresAt" < NOW()
      ORDER BY "expiresAt" ASC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "orphanBillingHistory",
    "BillingHistory rows without a valid Subscription",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "BillingHistory" billing
      LEFT JOIN "Subscription" subscription ON subscription."id" = billing."subscriptionId"
      WHERE subscription."id" IS NULL
    `,
    Prisma.sql`
      SELECT billing."id", billing."subscriptionId", billing."status", billing."createdAt"
      FROM "BillingHistory" billing
      LEFT JOIN "Subscription" subscription ON subscription."id" = billing."subscriptionId"
      WHERE subscription."id" IS NULL
      ORDER BY billing."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "adminsWithoutProfile",
    "ADMIN users without an AdminProfile",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "user" owner
      LEFT JOIN "AdminProfile" tenant ON tenant."userId" = owner."id"
      WHERE owner."role" = 'ADMIN' AND owner."status" <> 'DELETED' AND tenant."id" IS NULL
    `,
    Prisma.sql`
      SELECT owner."id", owner."email", owner."status", owner."createdAt"
      FROM "user" owner
      LEFT JOIN "AdminProfile" tenant ON tenant."userId" = owner."id"
      WHERE owner."role" = 'ADMIN' AND owner."status" <> 'DELETED' AND tenant."id" IS NULL
      ORDER BY owner."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "profilesWithoutOwner",
    "AdminProfile rows without an owner User",
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "AdminProfile" tenant
      LEFT JOIN "user" owner ON owner."id" = tenant."userId"
      WHERE owner."id" IS NULL
    `,
    Prisma.sql`
      SELECT tenant."id", tenant."userId", tenant."businessName", tenant."createdAt"
      FROM "AdminProfile" tenant
      LEFT JOIN "user" owner ON owner."id" = tenant."userId"
      WHERE owner."id" IS NULL
      ORDER BY tenant."createdAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  await add(
    "suspendedWithLiveSessions",
    "Suspended/archived tenants or suspended users that still have unexpired sessions",
    Prisma.sql`
      SELECT COUNT(DISTINCT session."id")::bigint AS count
      FROM "session" session
      JOIN "user" account ON account."id" = session."userId"
      LEFT JOIN "AdminProfile" owned_tenant ON owned_tenant."userId" = account."id"
      LEFT JOIN "StaffProfile" staff ON staff."userId" = account."id"
      LEFT JOIN "AdminProfile" staff_tenant ON staff_tenant."id" = staff."adminId"
      WHERE session."expiresAt" > NOW()
        AND (
          account."status" = 'SUSPENDED'
          OR owned_tenant."lifecycleStatus" IN ('SUSPENDED', 'ARCHIVED', 'PENDING_DELETION')
          OR staff_tenant."lifecycleStatus" IN ('SUSPENDED', 'ARCHIVED', 'PENDING_DELETION')
        )
    `,
    Prisma.sql`
      SELECT DISTINCT session."id" AS "sessionId", session."userId", session."expiresAt",
             account."role", account."status" AS "userStatus",
             COALESCE(owned_tenant."id", staff_tenant."id") AS "adminId",
             COALESCE(owned_tenant."lifecycleStatus"::text, staff_tenant."lifecycleStatus"::text) AS "lifecycleStatus"
      FROM "session" session
      JOIN "user" account ON account."id" = session."userId"
      LEFT JOIN "AdminProfile" owned_tenant ON owned_tenant."userId" = account."id"
      LEFT JOIN "StaffProfile" staff ON staff."userId" = account."id"
      LEFT JOIN "AdminProfile" staff_tenant ON staff_tenant."id" = staff."adminId"
      WHERE session."expiresAt" > NOW()
        AND (
          account."status" = 'SUSPENDED'
          OR owned_tenant."lifecycleStatus" IN ('SUSPENDED', 'ARCHIVED', 'PENDING_DELETION')
          OR staff_tenant."lifecycleStatus" IN ('SUSPENDED', 'ARCHIVED', 'PENDING_DELETION')
        )
      ORDER BY session."expiresAt" DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  );

  return findings;
}, { timeout: 60_000 });

const main = async () => {
  try {
    const findings = await runAudit();
    const totalFindings = findings.reduce((sum, finding) => sum + finding.count, 0);
    const report = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      totalFindings,
      clean: totalFindings === 0,
      findings,
    };

    console.log(JSON.stringify(jsonSafe(report), null, 2));
    if (ciMode && totalFindings > 0) process.exitCode = 1;
    if (reportOnly) process.exitCode = 0;
  } finally {
    await prisma.$disconnect();
  }
};

void main();
