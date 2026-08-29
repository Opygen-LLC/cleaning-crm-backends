import { prisma } from "../../lib/prisma/prisma";
import { ONBOARDING_STEPS } from "../../modules/Admin/admin.constant";

type Issue = {
  code: string;
  count: number;
  sample: unknown[];
  fixable: boolean;
};

type IdRow = { id: string };
type AdminWebsiteRow = {
  id: string;
  website: string | null;
  licenseNumber: string | null;
};
type InvalidStepsRow = {
  id: string;
  onboardingCompletedSteps: string[];
};

const fix = process.argv.includes("--fix");
const ci = process.argv.includes("--ci");
const reportOnly = process.argv.includes("--report-only");
const SAMPLE_LIMIT = 20;
const allowedOnboardingSteps = new Set<string>(ONBOARDING_STEPS.map((step) => step.key));

function report(code: string, rows: unknown[], fixable = false): Issue {
  const issue = {
    code,
    count: rows.length,
    sample: rows.slice(0, SAMPLE_LIMIT),
    fixable,
  };
  const marker = rows.length === 0 ? "OK" : fixable ? "FIXABLE" : "REVIEW";
  console.log(`[data:audit] ${marker} ${code}: ${rows.length}`);
  if (rows.length > 0) {
    console.log(JSON.stringify(issue.sample, null, 2));
  }
  return issue;
}

function classifyWebsite(value: string | null):
  | { kind: "empty" }
  | { kind: "url"; normalized: string }
  | { kind: "domain"; normalized: string }
  | { kind: "license"; normalized: string }
  | { kind: "unknown" } {
  const raw = value?.trim();
  if (!raw) return { kind: "empty" };

  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname
    ) {
      return { kind: "url", normalized: raw };
    }
  } catch {
    // Continue with conservative hostname/license classification.
  }

  const hostname =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/.*)?$/i;
  if (hostname.test(raw)) {
    return { kind: "domain", normalized: `https://${raw}` };
  }

  // Registration historically placed trade/license IDs in website. Only
  // classify values that look like an identifier (not prose) and contain a
  // digit, reducing the chance of moving a malformed real website value.
  const licenseLike = /^(?=.{1,80}$)(?=.*\d)[a-z0-9][a-z0-9_#./ -]*$/i;
  if (licenseLike.test(raw) && !/\s{2,}/.test(raw)) {
    return { kind: "license", normalized: raw };
  }

  return { kind: "unknown" };
}

async function collectIssues(): Promise<Issue[]> {
  const issues: Issue[] = [];

  const [
    adminUsersWithoutProfile,
    profilesWithoutUser,
    profilesWithoutWebsite,
    profilesWithoutSubscription,
    verifiedPendingAdmins,
    activeIncompleteAdmins,
    invalidWebsiteOwners,
    bookingFormTenantMismatch,
    notificationsWithoutAdmin,
    serviceCatalogWithoutAdmin,
    bookingServiceTenantMismatch,
    estimateServiceTenantMismatch,
    orphanSessions,
    orphanAliases,
    orphanDomains,
    duplicateSubdomains,
  ] = await Promise.all([
    prisma.$queryRaw<IdRow[]>`SELECT u."id" FROM "user" u LEFT JOIN "AdminProfile" a ON a."userId" = u."id" WHERE u."role" = 'ADMIN' AND a."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT a."id" FROM "AdminProfile" a LEFT JOIN "user" u ON u."id" = a."userId" WHERE u."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT a."id" FROM "AdminProfile" a LEFT JOIN "business_website" w ON w."adminId" = a."id" WHERE w."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT a."id" FROM "AdminProfile" a LEFT JOIN "Subscription" s ON s."adminId" = a."id" WHERE s."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT u."id" FROM "user" u WHERE u."role" = 'ADMIN' AND u."emailVerified" = true AND u."status" = 'PENDING'`,
    prisma.$queryRaw<IdRow[]>`SELECT u."id" FROM "user" u LEFT JOIN "AdminProfile" a ON a."userId" = u."id" LEFT JOIN "business_website" w ON w."adminId" = a."id" LEFT JOIN "Subscription" s ON s."adminId" = a."id" WHERE u."role" = 'ADMIN' AND u."status" = 'ACTIVE' AND (a."id" IS NULL OR w."id" IS NULL OR s."id" IS NULL)`,
    prisma.$queryRaw<IdRow[]>`SELECT w."id" FROM "business_website" w LEFT JOIN "AdminProfile" a ON a."id" = w."adminId" LEFT JOIN "user" u ON u."id" = a."userId" WHERE a."id" IS NULL OR u."id" IS NULL OR u."role" <> 'ADMIN'`,
    prisma.$queryRaw<IdRow[]>`SELECT w."id" FROM "business_website" w JOIN "booking_form" f ON f."id" = w."primaryBookingFormId" WHERE f."adminId" <> w."adminId"`,
    prisma.$queryRaw<IdRow[]>`SELECT n."id" FROM "notification" n LEFT JOIN "AdminProfile" a ON a."id" = n."adminId" WHERE a."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT s."id" FROM "service_catalog" s LEFT JOIN "AdminProfile" a ON a."id" = s."adminId" WHERE a."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT bfs."id" FROM "booking_form_service" bfs JOIN "booking_form" f ON f."id" = bfs."formId" JOIN "service_catalog" s ON s."id" = bfs."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
    prisma.$queryRaw<IdRow[]>`SELECT efs."id" FROM "estimate_form_service" efs JOIN "estimate_form" f ON f."id" = efs."formId" JOIN "service_catalog" s ON s."id" = efs."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
    prisma.$queryRaw<IdRow[]>`SELECT s."id" FROM "session" s LEFT JOIN "user" u ON u."id" = s."userId" WHERE u."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT a."id" FROM "website_subdomain_alias" a LEFT JOIN "business_website" w ON w."id" = a."websiteId" WHERE w."id" IS NULL`,
    prisma.$queryRaw<IdRow[]>`SELECT d."id" FROM "website_domain" d LEFT JOIN "business_website" w ON w."id" = d."websiteId" WHERE w."id" IS NULL`,
    prisma.$queryRaw<Array<{ subdomain: string; count: bigint }>>`
      SELECT "subdomain", COUNT(*)::bigint AS "count"
      FROM "business_website"
      GROUP BY "subdomain"
      HAVING COUNT(*) > 1
    `,
  ]);

  issues.push(report("ADMIN_USER_WITHOUT_PROFILE", adminUsersWithoutProfile));
  issues.push(report("ADMIN_PROFILE_WITHOUT_USER", profilesWithoutUser));
  issues.push(report("ADMIN_PROFILE_WITHOUT_WEBSITE", profilesWithoutWebsite));
  issues.push(report("ADMIN_PROFILE_WITHOUT_SUBSCRIPTION", profilesWithoutSubscription));
  issues.push(report("VERIFIED_ADMIN_STILL_PENDING", verifiedPendingAdmins));
  issues.push(report("ACTIVE_ADMIN_INCOMPLETE_INVARIANTS", activeIncompleteAdmins));
  issues.push(report("WEBSITE_INVALID_OWNER", invalidWebsiteOwners));
  issues.push(report("BOOKING_FORM_CROSS_TENANT_ATTACHMENT", bookingFormTenantMismatch));
  issues.push(report("NOTIFICATION_WITHOUT_ADMIN", notificationsWithoutAdmin));
  issues.push(report("SERVICE_CATALOG_WITHOUT_ADMIN", serviceCatalogWithoutAdmin));
  issues.push(report("BOOKING_SERVICE_CROSS_TENANT", bookingServiceTenantMismatch));
  issues.push(report("ESTIMATE_SERVICE_CROSS_TENANT", estimateServiceTenantMismatch));
  issues.push(report("ORPHAN_SESSION", orphanSessions));
  issues.push(report("ORPHAN_WEBSITE_ALIAS", orphanAliases));
  issues.push(report("ORPHAN_WEBSITE_DOMAIN", orphanDomains));
  issues.push(
    report(
      "DUPLICATE_SUBDOMAIN",
      duplicateSubdomains.map((row) => ({
        subdomain: row.subdomain,
        count: Number(row.count),
      })),
    ),
  );

  const [
    duplicateWebsiteOwnership,
    danglingPrimaryBookingForm,
    danglingPrimaryEstimateForm,
    subscriptionsWithoutPlan,
    subscriptionsWithoutSubscriptionPlan,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ adminId: string; count: bigint }>>`
      SELECT "adminId", COUNT(*)::bigint AS "count"
      FROM "business_website"
      GROUP BY "adminId"
      HAVING COUNT(*) > 1
    `,
    prisma.$queryRaw<IdRow[]>`
      SELECT w."id" FROM "business_website" w
      LEFT JOIN "booking_form" f ON f."id" = w."primaryBookingFormId"
      WHERE w."primaryBookingFormId" IS NOT NULL AND f."id" IS NULL
    `,
    prisma.$queryRaw<IdRow[]>`
      SELECT w."id" FROM "business_website" w
      LEFT JOIN "estimate_form" f ON f."id" = w."primaryEstimateFormId"
      WHERE w."primaryEstimateFormId" IS NOT NULL AND f."id" IS NULL
    `,
    prisma.$queryRaw<IdRow[]>`
      SELECT s."id" FROM "Subscription" s
      LEFT JOIN "Plan" p ON p."id" = s."planId"
      WHERE p."id" IS NULL
    `,
    prisma.$queryRaw<IdRow[]>`
      SELECT s."id" FROM "Subscription" s
      LEFT JOIN "SubscriptionPlan" p ON p."id" = s."subscriptionPlanId"
      WHERE p."id" IS NULL
    `,
  ]);

  issues.push(report("DUPLICATE_WEBSITE_OWNERSHIP", duplicateWebsiteOwnership.map((row) => ({ adminId: row.adminId, count: Number(row.count) }))));
  issues.push(report("DANGLING_PRIMARY_BOOKING_FORM", danglingPrimaryBookingForm));
  issues.push(report("DANGLING_PRIMARY_ESTIMATE_FORM", danglingPrimaryEstimateForm));
  issues.push(report("SUBSCRIPTION_WITHOUT_PLAN", subscriptionsWithoutPlan));
  issues.push(report("SUBSCRIPTION_WITHOUT_SUBSCRIPTION_PLAN", subscriptionsWithoutSubscriptionPlan));

  const profiles = await prisma.adminProfile.findMany({
    select: {
      id: true,
      website: true,
      licenseNumber: true,
      onboardingCompletedSteps: true,
    },
  });

  const licenseCandidates: Array<{
    id: string;
    website: string;
    classification: string;
  }> = [];
  const domainNormalizationCandidates: Array<{
    id: string;
    website: string;
    normalized: string;
  }> = [];
  const unknownWebsiteValues: Array<{ id: string; website: string }> = [];
  const invalidSteps: InvalidStepsRow[] = [];

  for (const profile of profiles as Array<AdminWebsiteRow & InvalidStepsRow>) {
    const classified = classifyWebsite(profile.website);
    if (
      classified.kind === "license" &&
      !profile.licenseNumber &&
      profile.website
    ) {
      licenseCandidates.push({
        id: profile.id,
        website: profile.website,
        classification: classified.kind,
      });
    } else if (
      classified.kind === "domain" &&
      profile.website &&
      classified.normalized !== profile.website
    ) {
      domainNormalizationCandidates.push({
        id: profile.id,
        website: profile.website,
        normalized: classified.normalized,
      });
    } else if (classified.kind === "unknown" && profile.website) {
      unknownWebsiteValues.push({ id: profile.id, website: profile.website });
    }

    const seen = new Set<string>();
    const normalized = ONBOARDING_STEPS.map((step) => step.key).filter((step) => {
      if (!profile.onboardingCompletedSteps.includes(step) || seen.has(step)) {
        return false;
      }
      seen.add(step);
      return true;
    });
    const hasInvalid = profile.onboardingCompletedSteps.some(
      (step) => !allowedOnboardingSteps.has(step),
    );
    const hasDuplicates =
      new Set(profile.onboardingCompletedSteps).size !==
      profile.onboardingCompletedSteps.length;
    const orderMismatch =
      normalized.join("|") !== profile.onboardingCompletedSteps.join("|");

    if (hasInvalid || hasDuplicates || orderMismatch) {
      invalidSteps.push({
        id: profile.id,
        onboardingCompletedSteps: profile.onboardingCompletedSteps,
      });
    }
  }

  issues.push(report("LICENSE_NUMBER_STORED_IN_WEBSITE", licenseCandidates, true));
  issues.push(report("WEBSITE_HOSTNAME_NEEDS_NORMALIZATION", domainNormalizationCandidates, true));
  issues.push(report("WEBSITE_VALUE_REQUIRES_MANUAL_REVIEW", unknownWebsiteValues));
  issues.push(report("INVALID_ONBOARDING_COMPLETED_STEPS", invalidSteps, true));

  return issues;
}

async function applySafeFixes(): Promise<void> {
  const profiles = await prisma.adminProfile.findMany({
    select: {
      id: true,
      website: true,
      licenseNumber: true,
      onboardingCompletedSteps: true,
    },
  });

  let migratedLicenses = 0;
  let normalizedDomains = 0;
  let normalizedStepRows = 0;

  for (const profile of profiles) {
    const classified = classifyWebsite(profile.website);

    if (
      classified.kind === "license" &&
      !profile.licenseNumber &&
      profile.website
    ) {
      await prisma.adminProfile.update({
        where: { id: profile.id },
        data: {
          licenseNumber: classified.normalized,
          website: null,
        },
      });
      migratedLicenses += 1;
    } else if (
      classified.kind === "domain" &&
      profile.website &&
      classified.normalized !== profile.website
    ) {
      await prisma.adminProfile.update({
        where: { id: profile.id },
        data: { website: classified.normalized },
      });
      normalizedDomains += 1;
    }

    const normalizedSteps = ONBOARDING_STEPS.map((step) => step.key).filter(
      (step) => profile.onboardingCompletedSteps.includes(step),
    );
    if (
      normalizedSteps.join("|") !== profile.onboardingCompletedSteps.join("|")
    ) {
      await prisma.adminProfile.update({
        where: { id: profile.id },
        data: { onboardingCompletedSteps: normalizedSteps },
      });
      normalizedStepRows += 1;
    }
  }

  console.log(
    `[data:audit] applied safe fixes: licenses=${migratedLicenses}, domains=${normalizedDomains}, onboardingSteps=${normalizedStepRows}`,
  );
}

async function main() {
  const mode = fix ? "fix" : ci ? "ci" : reportOnly ? "report-only" : "dry-run";
  console.log(`[data:audit] mode=${mode}`);
  const before = await collectIssues();
  let finalIssues = before;

  if (fix) {
    await applySafeFixes();
    console.log("[data:audit] re-running audit after safe fixes");
    finalIssues = await collectIssues();
  }

  const beforeTotal = before.reduce((sum, issue) => sum + issue.count, 0);
  const finalTotal = finalIssues.reduce((sum, issue) => sum + issue.count, 0);
  console.log(`[data:audit] completed; issues-before-fix=${beforeTotal}; issues-final=${finalTotal}`);

  if (ci && !reportOnly && finalTotal > 0) {
    console.error(`[data:audit] CI gate failed with ${finalTotal} integrity issue(s)`);
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error("[data:audit] fatal", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
