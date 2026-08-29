import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeBusinessHours } from "../../modules/Admin/businessHours";
import { ONBOARDING_STEPS } from "../../modules/Admin/admin.constant";
import { getCanonicalWebsiteOrigin } from "../../modules/Website/websiteCanonicalHost";

const applyFixes = process.argv.includes("--fix");
const REQUIRED_STEPS = ONBOARDING_STEPS.map((step) => step.key);

type Severity = "P0" | "P1" | "P2";
type Finding = {
  severity: Severity;
  code: string;
  entity: string;
  entityId: string;
  adminId?: string;
  detail: string;
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

async function reconcileEnumDrift() {
  const invalidServices = await prisma.$queryRaw<Array<{ id: string; adminId: string; category: string }>>`
    SELECT id, "adminId", category::text AS category
    FROM "service_catalog"
    WHERE category::text NOT IN ('RESIDENTIAL', 'COMMERCIAL', 'SPECIALIST')
  `;
  for (const row of invalidServices) {
    let fixed = false;
    if (applyFixes) {
      const normalized = row.category.trim().toUpperCase().replace(/[\s-]+/g, "_");
      const mapped = LEGACY_SERVICE_CATEGORY_MAP[normalized];
      if (mapped) {
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "service_catalog" SET category = ${mapped}::"ServiceCategory" WHERE id = ${row.id}
        `);
        fixed = true;
      }
    }
    add({ severity: "P1", code: "INVALID_SERVICE_CATEGORY", entity: "ServiceCatalog", entityId: row.id, adminId: row.adminId, detail: `category=${row.category}`, fixed });
  }

  const legacyStaff = await prisma.$queryRaw<Array<{ id: string; adminId: string; status: string }>>`
    SELECT id, "adminId", status::text AS status
    FROM "StaffProfile"
    WHERE status::text NOT IN ('ACTIVE', 'INACTIVE', 'ON_LEAVE')
  `;
  for (const row of legacyStaff) {
    let fixed = false;
    if (applyFixes && row.status.toUpperCase() === "DEACTIVE") {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "StaffProfile"
        SET status = 'INACTIVE'::"StaffStatus", "manuallyInactive" = true
        WHERE id = ${row.id}
      `);
      fixed = true;
    }
    add({ severity: "P1", code: "LEGACY_STAFF_STATUS", entity: "StaffProfile", entityId: row.id, adminId: row.adminId, detail: `status=${row.status}`, fixed });
  }
}

async function reconcileBusinessHours() {
  const admins = await prisma.adminProfile.findMany({ select: { id: true, businessHours: true } });
  for (const admin of admins) {
    if (admin.businessHours == null) continue;
    const normalized = normalizeBusinessHours(admin.businessHours);
    const differs = normalized == null || stable(admin.businessHours) !== stable(normalized);
    if (!differs) continue;

    let fixed = false;
    if (applyFixes && normalized) {
      await prisma.adminProfile.update({ where: { id: admin.id }, data: { businessHours: normalized } });
      fixed = true;
    }
    add({ severity: "P1", code: "MALFORMED_BUSINESS_HOURS", entity: "AdminProfile", entityId: admin.id, adminId: admin.id, detail: normalized ? "legacy/partial hours require canonical normalization" : "businessHours could not be normalized", fixed });
  }
}

async function scanRelationshipIntegrity() {
  const orphanWebsiteForms = await prisma.$queryRaw<Array<{ id: string; adminId: string; formId: string }>>`
    SELECT bw.id, bw."adminId", bw."primaryBookingFormId" AS "formId"
    FROM "business_website" bw
    LEFT JOIN "booking_form" bf ON bf.id = bw."primaryBookingFormId"
    WHERE bw."primaryBookingFormId" IS NOT NULL AND bf.id IS NULL
  `;
  for (const row of orphanWebsiteForms) {
    let fixed = false;
    if (applyFixes) {
      await prisma.businessWebsite.update({ where: { id: row.id }, data: { primaryBookingFormId: null, bookingEnabled: false } });
      fixed = true;
    }
    add({ severity: "P0", code: "ORPHANED_PRIMARY_BOOKING_FORM", entity: "BusinessWebsite", entityId: row.id, adminId: row.adminId, detail: `missing booking form ${row.formId}`, fixed });
  }

  const orphanBookingServices = await prisma.$queryRaw<Array<{ id: string; adminId: string; serviceCatalogId: string }>>`
    SELECT b.id, b."adminId", b."serviceCatalogId"
    FROM "booking" b
    LEFT JOIN "service_catalog" sc ON sc.id = b."serviceCatalogId"
    WHERE b."serviceCatalogId" IS NOT NULL AND sc.id IS NULL
  `;
  for (const row of orphanBookingServices) {
    add({ severity: "P1", code: "BOOKING_REFERENCES_MISSING_SERVICE", entity: "Booking", entityId: row.id, adminId: row.adminId, detail: `missing service ${row.serviceCatalogId}` });
  }
}

async function scanOnboardingAndWebsiteState() {
  const admins = await prisma.adminProfile.findMany({
    select: {
      id: true,
      businessName: true,
      businessHours: true,
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
      serviceCatalogs: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 },
      businessWebsite: {
        select: {
          id: true,
          adminId: true,
          subdomain: true,
          status: true,
          bookingEnabled: true,
          primaryBookingFormId: true,
          draftRevisionNumber: true,
          publishedRevisionNumber: true,
          publishedSnapshot: true,
          primaryBookingForm: { select: { id: true, published: true, adminId: true } },
          domains: { where: { isPrimary: true, status: "VERIFIED" }, select: { domain: true }, take: 1 },
          revisions: { orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true, snapshot: true }, take: 1 },
        },
      },
    },
  });

  for (const admin of admins) {
    const completed = new Set(admin.onboardingCompletedSteps);
    const claimsComplete = admin.onboardingCompletedAt != null || REQUIRED_STEPS.every((step) => completed.has(step));
    if (claimsComplete) {
      const missing: string[] = [];
      if (!admin.businessName.trim()) missing.push("businessName");
      if (!admin.businessWebsite) missing.push("website");
      if (!admin.serviceCatalogs.length) missing.push("activeService");
      if (missing.length) {
        add({ severity: "P0", code: "ONBOARDING_COMPLETE_WITH_MISSING_DATA", entity: "AdminProfile", entityId: admin.id, adminId: admin.id, detail: `missing=${missing.join(",")}` });
      }
    }

    const website = admin.businessWebsite;
    if (!website) continue;
    const latestRevision = website.revisions[0]?.revisionNumber ?? 0;
    if (website.draftRevisionNumber !== latestRevision) {
      let fixed = false;
      if (applyFixes) {
        await prisma.businessWebsite.update({ where: { id: website.id }, data: { draftRevisionNumber: latestRevision } });
        fixed = true;
      }
      add({ severity: "P1", code: "WEBSITE_DRAFT_REVISION_MISMATCH", entity: "BusinessWebsite", entityId: website.id, adminId: admin.id, detail: `draft=${website.draftRevisionNumber}, latest=${latestRevision}`, fixed });
    }

    if (website.status === "PUBLISHED") {
      const publishedNumber = website.publishedRevisionNumber;
      if (!publishedNumber || publishedNumber > latestRevision || website.publishedSnapshot == null) {
        add({ severity: "P0", code: "WEBSITE_PUBLISHED_REVISION_MISMATCH", entity: "BusinessWebsite", entityId: website.id, adminId: admin.id, detail: `published=${publishedNumber ?? "null"}, latest=${latestRevision}, snapshot=${website.publishedSnapshot == null ? "missing" : "present"}` });
      }
    }

    const primaryFormTenantMismatch = Boolean(website.primaryBookingForm && website.primaryBookingForm.adminId !== admin.id);
    if (primaryFormTenantMismatch) {
      let fixed = false;
      if (applyFixes) {
        await prisma.businessWebsite.update({
          where: { id: website.id },
          data: { primaryBookingFormId: null, bookingEnabled: false },
        });
        fixed = true;
      }
      add({
        severity: "P0",
        code: "PRIMARY_BOOKING_FORM_TENANT_MISMATCH",
        entity: "BusinessWebsite",
        entityId: website.id,
        adminId: admin.id,
        detail: `formAdminId=${website.primaryBookingForm?.adminId ?? "null"}`,
        fixed,
      });
    }

    if (!primaryFormTenantMismatch && website.bookingEnabled && (!website.primaryBookingFormId || !website.primaryBookingForm || !website.primaryBookingForm.published)) {
      add({ severity: "P0", code: "BOOKING_ENABLED_WITHOUT_ACTIVE_FORM", entity: "BusinessWebsite", entityId: website.id, adminId: admin.id, detail: `primaryBookingFormId=${website.primaryBookingFormId ?? "null"}` });
    }

    const primaryCustomDomain = website.domains[0]?.domain ?? null;
    const origin = getCanonicalWebsiteOrigin(website.subdomain, primaryCustomDomain);
    let validOrigin = false;
    if (origin) {
      try { validOrigin = new URL(origin).protocol === "https:"; } catch { validOrigin = false; }
    }
    if (!validOrigin) {
      add({ severity: "P1", code: "INVALID_TENANT_PUBLIC_URL", entity: "BusinessWebsite", entityId: website.id, adminId: admin.id, detail: `subdomain=${website.subdomain}, primaryDomain=${primaryCustomDomain ?? "none"}` });
    }
  }
}

async function main() {
  await reconcileEnumDrift();
  await reconcileBusinessHours();
  await scanRelationshipIntegrity();
  await scanOnboardingAndWebsiteState();

  const summary = findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ mode: applyFixes ? "fix" : "report", summary, findings }, null, 2));

  if (findings.some((finding) => finding.severity === "P0" && !finding.fixed)) process.exitCode = 2;
  else if (findings.some((finding) => finding.severity === "P1" && !finding.fixed)) process.exitCode = 1;
}

void main().finally(async () => prisma.$disconnect());
