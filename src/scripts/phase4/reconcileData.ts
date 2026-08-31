import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeBusinessHours } from "../../modules/Admin/businessHours";
import { API_CONTRACT } from "../../contracts/apiContract";
import {
  IntegrityFindingGroup,
  IntegrityRow,
  SafeFixAction,
  normalizeForJson,
  runIntegrityChecks,
} from "../integrity/integrityChecks";

const applyFixes = process.argv.includes("--fix");

type Severity = "P0" | "P1" | "P2";
type Finding = {
  severity: Severity;
  category: string;
  code: string;
  entity: string;
  entityId: string;
  adminId?: string;
  detail: string;
  fixable: boolean;
  fixed?: boolean;
};

const findings: Finding[] = [];
const add = (finding: Finding) => findings.push(finding);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};
const stable = (value: unknown) => JSON.stringify(canonicalize(value));

const LEGACY_SERVICE_CATEGORY_MAP: Readonly<Record<string, "RESIDENTIAL" | "COMMERCIAL" | "SPECIALIST">> = {
  STANDARD: "RESIDENTIAL",
  HOME: "RESIDENTIAL",
  DOMESTIC: "RESIDENTIAL",
  RESIDENTIAL_CLEANING: "RESIDENTIAL",
  OFFICE: "COMMERCIAL",
  BUSINESS: "COMMERCIAL",
  COMMERCIAL_CLEANING: "COMMERCIAL",
  DEEP_CLEAN: "SPECIALIST",
  SPECIALIZED: "SPECIALIST",
  SPECIALISED: "SPECIALIST",
};

function rowId(row: IntegrityRow): string {
  return typeof row.id === "string" ? row.id : "unknown";
}

function detailForRow(group: IntegrityFindingGroup, row: IntegrityRow): string {
  const compact = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "id" && key !== "adminId"),
  );
  const rowDetail = JSON.stringify(normalizeForJson(compact));
  return rowDetail === "{}" ? group.description : `${group.description} ${rowDetail}`;
}

async function executeSafeFix(action: SafeFixAction, row: IntegrityRow): Promise<boolean> {
  const id = rowId(row);
  if (id === "unknown") return false;
  const relationId = typeof row.relationId === "string" ? row.relationId : null;

  switch (action) {
    case "DELETE_EXPIRED_SESSION":
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "session" WHERE id=${id} AND "expiresAt" < NOW()`)) > 0;
    case "DELETE_SESSION":
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "session" WHERE id=${id}`)) > 0;
    case "NORMALIZE_ONBOARDING_STEPS": {
      const steps = Array.isArray(row.normalizedSteps)
        ? row.normalizedSteps.filter((value): value is string => typeof value === "string")
        : [];
      await prisma.adminProfile.update({ where: { id }, data: { onboardingCompletedSteps: steps } });
      return true;
    }
    case "BACKFILL_COMPLETED_ONBOARDING_STEPS":
      await prisma.adminProfile.update({
        where: { id },
        data: { onboardingCompletedSteps: [...API_CONTRACT.onboardingStep] },
      });
      return true;
    case "SYNC_DRAFT_REVISION": {
      const latestRevision = Number(row.latestRevision ?? 0);
      if (!Number.isInteger(latestRevision) || latestRevision < 0) return false;
      await prisma.businessWebsite.update({ where: { id }, data: { draftRevisionNumber: latestRevision } });
      return true;
    }
    case "CLEAR_BOOKING_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "booking" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "DELETE_BOOKING_STAFF_ASSIGNMENT":
      if (!relationId) return false;
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "booking_staff_assignment" WHERE "bookingId"=${id} AND "staffId"=${relationId}`)) > 0;
    case "CLEAR_LEAD_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "lead" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_LEAD_SOURCE_WEBSITE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "lead" SET "sourceWebsiteId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_JOB_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "job" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_JOB_QUOTE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "job" SET "quoteId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_JOB_ESTIMATE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "job" SET "estimateId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_JOB_BOOKING":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "job" SET "bookingId"=NULL WHERE id=${id}`)) > 0;
    case "DELETE_JOB_STAFF_ASSIGNMENT":
      if (!relationId) return false;
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "job_staff_assignment" WHERE "jobId"=${id} AND "staffId"=${relationId}`)) > 0;
    case "CLEAR_INVOICE_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "invoice" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_INVOICE_BOOKING":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "invoice" SET "bookingId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_PAYMENT_INVOICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "payment" SET "invoiceId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_QUOTE_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "quote" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_ESTIMATE_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "estimate" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_REVIEW_STAFF":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "review" SET "staffId"=NULL WHERE id=${id}`)) > 0;
    case "DETACH_PRIMARY_BOOKING_FORM":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "business_website" SET "primaryBookingFormId"=NULL, "bookingEnabled"=false WHERE id=${id}`)) > 0;
    case "DETACH_PRIMARY_ESTIMATE_FORM":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "business_website" SET "primaryEstimateFormId"=NULL, "estimateEnabled"=false WHERE id=${id}`)) > 0;
    case "DELETE_BOOKING_FORM_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "booking_form_service" WHERE id=${id}`)) > 0;
    case "CLEAR_BOOKING_SUBMISSION_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "booking_form_submission" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_BOOKING_SUBMISSION_SOURCE_WEBSITE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "booking_form_submission" SET "sourceWebsiteId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_BOOKING_SUBMISSION_CONVERTED_BOOKING":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "booking_form_submission" SET "convertedBookingId"=NULL, "convertedAt"=NULL WHERE id=${id}`)) > 0;
    case "DELETE_ESTIMATE_FORM_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "estimate_form_service" WHERE id=${id}`)) > 0;
    case "CLEAR_ESTIMATE_SUBMISSION_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "estimate_form_submission" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_ESTIMATE_SUBMISSION_SOURCE_WEBSITE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "estimate_form_submission" SET "sourceWebsiteId"=NULL WHERE id=${id}`)) > 0;
    case "CLEAR_CHECKLIST_TEMPLATE_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "checklist_template" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "DELETE_RECURRING_STAFF_ASSIGNMENT":
      if (!relationId) return false;
      return (await prisma.$executeRaw(Prisma.sql`DELETE FROM "recurring_staff_assignment" WHERE "scheduleId"=${id} AND "staffId"=${relationId}`)) > 0;
    case "CLEAR_RECURRING_SERVICE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "recurring_schedule" SET "serviceCatalogId"=NULL WHERE id=${id}`)) > 0;
    case "DISABLE_BOOKING":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "business_website" SET "bookingEnabled"=false WHERE id=${id}`)) > 0;
    case "DISABLE_ESTIMATE":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "business_website" SET "estimateEnabled"=false WHERE id=${id}`)) > 0;
    case "UNSET_INVALID_PRIMARY_DOMAIN":
      return (await prisma.$executeRaw(Prisma.sql`UPDATE "website_domain" SET "isPrimary"=false WHERE id=${id}`)) > 0;
    case "SYNC_SUBSCRIPTION_PLAN_PARENT": {
      const expectedSubscriptionPlanId = typeof row.expectedSubscriptionPlanId === "string"
        ? row.expectedSubscriptionPlanId
        : null;
      if (!expectedSubscriptionPlanId) return false;
      return (await prisma.$executeRaw(Prisma.sql`
        UPDATE "Subscription"
        SET "subscriptionPlanId"=${expectedSubscriptionPlanId}
        WHERE id=${id}
      `)) > 0;
    }
  }

  const exhaustive: never = action;
  return exhaustive;
}

async function collectIntegrityFindings(groups: IntegrityFindingGroup[], performFixes: boolean) {
  for (const group of groups) {
    for (const row of group.rows) {
      let fixed = false;
      if (performFixes && group.fixAction) {
        fixed = await executeSafeFix(group.fixAction, row);
      }
      add({
        severity: group.severity,
        category: group.category,
        code: group.code,
        entity: group.entity,
        entityId: rowId(row),
        adminId: typeof row.adminId === "string" ? row.adminId : undefined,
        detail: detailForRow(group, row),
        fixable: Boolean(group.fixAction),
        fixed,
      });
    }
  }
}

async function reconcileEnumDrift(performFixes: boolean) {
  const invalidServices = await prisma.$queryRaw<Array<{ id: string; adminId: string; category: string }>>`
    SELECT id, "adminId", category::text AS category
    FROM "service_catalog"
    WHERE category::text NOT IN ('RESIDENTIAL', 'COMMERCIAL', 'SPECIALIST')
  `;
  for (const row of invalidServices) {
    let fixed = false;
    if (performFixes) {
      const normalized = row.category.trim().toUpperCase().replace(/[\s-]+/g, "_");
      const mapped = LEGACY_SERVICE_CATEGORY_MAP[normalized];
      if (mapped) {
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "service_catalog" SET category = ${mapped}::"ServiceCategory" WHERE id = ${row.id}
        `);
        fixed = true;
      }
    }
    add({ severity: "P1", category: "contract", code: "INVALID_SERVICE_CATEGORY", entity: "ServiceCatalog", entityId: row.id, adminId: row.adminId, detail: `category=${row.category}`, fixable: Boolean(LEGACY_SERVICE_CATEGORY_MAP[row.category.trim().toUpperCase().replace(/[\s-]+/g, "_")]), fixed });
  }

  const legacyStaff = await prisma.$queryRaw<Array<{ id: string; adminId: string; status: string }>>`
    SELECT id, "adminId", status::text AS status
    FROM "StaffProfile"
    WHERE status::text NOT IN ('ACTIVE', 'INACTIVE', 'ON_LEAVE')
  `;
  for (const row of legacyStaff) {
    let fixed = false;
    if (performFixes && row.status.toUpperCase() === "DEACTIVE") {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "StaffProfile"
        SET status = 'INACTIVE'::"StaffStatus", "manuallyInactive" = true
        WHERE id = ${row.id}
      `);
      fixed = true;
    }
    add({ severity: "P1", category: "contract", code: "LEGACY_STAFF_STATUS", entity: "StaffProfile", entityId: row.id, adminId: row.adminId, detail: `status=${row.status}`, fixable: row.status.toUpperCase() === "DEACTIVE", fixed });
  }
}

async function reconcileBusinessHours(performFixes: boolean) {
  const admins = await prisma.adminProfile.findMany({ select: { id: true, businessHours: true } });
  for (const admin of admins) {
    if (admin.businessHours == null) continue;
    const normalized = normalizeBusinessHours(admin.businessHours);
    const differs = normalized == null || stable(admin.businessHours) !== stable(normalized);
    if (!differs) continue;

    let fixed = false;
    if (performFixes && normalized) {
      await prisma.adminProfile.update({ where: { id: admin.id }, data: { businessHours: normalized } });
      fixed = true;
    }
    add({
      severity: "P1",
      category: "onboarding",
      code: "MALFORMED_BUSINESS_HOURS",
      entity: "AdminProfile",
      entityId: admin.id,
      adminId: admin.id,
      detail: normalized ? "legacy/partial hours require canonical normalization" : "businessHours could not be normalized",
      fixable: Boolean(normalized),
      fixed,
    });
  }
}

async function runPass(performFixes: boolean) {
  findings.length = 0;
  const groups = await runIntegrityChecks();
  await collectIntegrityFindings(groups, performFixes);
  await reconcileEnumDrift(performFixes);
  await reconcileBusinessHours(performFixes);
}

function printSummary(mode: "report" | "fix-preflight" | "fix-result") {
  const summary = findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    acc[finding.category] = (acc[finding.category] ?? 0) + 1;
    if (finding.fixed) acc.fixed = (acc.fixed ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ mode, summary, findings }, null, 2));
}

async function main() {
  // Always report the exact pre-mutation state first. This makes --fix safe to
  // run only after operators have already reviewed db:reconcile output, while
  // still preserving an audit trail if --fix is invoked directly.
  await runPass(false);
  printSummary(applyFixes ? "fix-preflight" : "report");

  if (applyFixes) {
    await runPass(true);
    const appliedCount = findings.filter((finding) => finding.fixed).length;
    console.log(`[db:reconcile] deterministic fixes applied=${appliedCount}; re-auditing`);
    await runPass(false);
    printSummary("fix-result");
  }

  if (findings.some((finding) => finding.severity === "P0" && !finding.fixed)) process.exitCode = 2;
  else if (findings.some((finding) => finding.severity === "P1" && !finding.fixed)) process.exitCode = 1;
}

void main()
  .catch((error) => {
    console.error("[db:reconcile] fatal", error);
    process.exitCode = 3;
  })
  .finally(async () => prisma.$disconnect());
