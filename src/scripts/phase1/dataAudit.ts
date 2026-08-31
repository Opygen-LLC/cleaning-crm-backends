import { prisma } from "../../lib/prisma/prisma";
import { ONBOARDING_STEPS } from "../../modules/Admin/admin.constant";
import {
  IntegrityFindingGroup,
  normalizeForJson,
  runIntegrityChecks,
} from "../integrity/integrityChecks";

type LegacyIssue = {
  code: string;
  severity: "P1" | "P2";
  count: number;
  sample: unknown[];
  fixable: boolean;
};

type AdminWebsiteRow = {
  id: string;
  website: string | null;
  licenseNumber: string | null;
};

const fix = process.argv.includes("--fix");
const ci = process.argv.includes("--ci");
const strict = process.argv.includes("--strict");
const reportOnly = process.argv.includes("--report-only");
const SAMPLE_LIMIT = 20;

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
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) {
      return { kind: "url", normalized: raw };
    }
  } catch {
    // Continue with conservative hostname/license classification.
  }

  const hostname =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/.*)?$/i;
  if (hostname.test(raw)) return { kind: "domain", normalized: `https://${raw}` };

  const licenseLike = /^(?=.{1,80}$)(?=.*\d)[a-z0-9][a-z0-9_#./ -]*$/i;
  if (licenseLike.test(raw) && !/\s{2,}/.test(raw)) {
    return { kind: "license", normalized: raw };
  }

  return { kind: "unknown" };
}

function printIntegrityGroup(group: IntegrityFindingGroup) {
  const marker = group.rows.length === 0 ? "OK" : group.fixAction ? "FIXABLE" : "REVIEW";
  console.log(
    `[data:audit] ${marker} ${group.severity} ${group.category}/${group.code}: ${group.rows.length}`,
  );
  if (group.rows.length > 0) {
    console.log(
      JSON.stringify(normalizeForJson(group.rows.slice(0, SAMPLE_LIMIT)), null, 2),
    );
  }
}

function printLegacyIssue(issue: LegacyIssue) {
  const marker = issue.count === 0 ? "OK" : issue.fixable ? "FIXABLE" : "REVIEW";
  console.log(`[data:audit] ${marker} ${issue.severity} legacy/${issue.code}: ${issue.count}`);
  if (issue.count > 0) console.log(JSON.stringify(normalizeForJson(issue.sample), null, 2));
}

async function collectLegacyProfileIssues(): Promise<LegacyIssue[]> {
  const profiles = await prisma.adminProfile.findMany({
    select: { id: true, website: true, licenseNumber: true },
  });

  const licenseCandidates: Array<{ id: string; website: string }> = [];
  const domainNormalizationCandidates: Array<{ id: string; website: string; normalized: string }> = [];
  const unknownWebsiteValues: Array<{ id: string; website: string }> = [];

  for (const profile of profiles as AdminWebsiteRow[]) {
    const classified = classifyWebsite(profile.website);
    if (classified.kind === "license" && !profile.licenseNumber && profile.website) {
      licenseCandidates.push({ id: profile.id, website: profile.website });
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
  }

  return [
    {
      code: "LICENSE_NUMBER_STORED_IN_WEBSITE",
      severity: "P1",
      count: licenseCandidates.length,
      sample: licenseCandidates.slice(0, SAMPLE_LIMIT),
      fixable: true,
    },
    {
      code: "WEBSITE_HOSTNAME_NEEDS_NORMALIZATION",
      severity: "P2",
      count: domainNormalizationCandidates.length,
      sample: domainNormalizationCandidates.slice(0, SAMPLE_LIMIT),
      fixable: true,
    },
    {
      code: "WEBSITE_VALUE_REQUIRES_MANUAL_REVIEW",
      severity: "P1",
      count: unknownWebsiteValues.length,
      sample: unknownWebsiteValues.slice(0, SAMPLE_LIMIT),
      fixable: false,
    },
  ];
}

async function applyLegacySafeFixes(): Promise<void> {
  const profiles = await prisma.adminProfile.findMany({
    select: { id: true, website: true, licenseNumber: true },
  });

  let migratedLicenses = 0;
  let normalizedDomains = 0;
  for (const profile of profiles) {
    const classified = classifyWebsite(profile.website);
    if (classified.kind === "license" && !profile.licenseNumber && profile.website) {
      await prisma.adminProfile.update({
        where: { id: profile.id },
        data: { licenseNumber: classified.normalized, website: null },
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
  }

  console.log(
    `[data:audit] applied legacy safe fixes: licenses=${migratedLicenses}, domains=${normalizedDomains}`,
  );
}

async function runAudit() {
  const integrity = await runIntegrityChecks();
  const legacy = await collectLegacyProfileIssues();
  for (const group of integrity) printIntegrityGroup(group);
  for (const issue of legacy) printLegacyIssue(issue);
  return { integrity, legacy };
}

async function main() {
  const mode = fix ? "fix" : ci ? "ci" : reportOnly ? "report-only" : "dry-run";
  console.log(`[data:audit] mode=${mode}`);
  console.log(`[data:audit] canonical onboarding steps=${ONBOARDING_STEPS.map((step) => step.key).join(",")}`);

  const before = await runAudit();
  let final = before;

  if (fix) {
    // Broad tenant/auth reconciliation intentionally lives in db:reconcile:fix.
    // data:audit --fix retains only the historical, deterministic profile-field
    // cleanup so old deployment workflows remain backwards compatible.
    await applyLegacySafeFixes();
    console.log("[data:audit] re-running audit after legacy safe fixes");
    final = await runAudit();
  }

  const summary = final.integrity.reduce(
    (acc, group) => {
      acc[group.severity] += group.rows.length;
      acc[group.category] += group.rows.length;
      return acc;
    },
    { P0: 0, P1: 0, P2: 0, auth: 0, tenant: 0, onboarding: 0, website: 0 },
  );
  const legacyTotal = final.legacy.reduce((sum, issue) => sum + issue.count, 0);

  console.log(
    JSON.stringify(
      {
        mode,
        summary: { ...summary, legacy: legacyTotal },
        acceptance: {
          p0TenantIntegrity: final.integrity
            .filter((g) => g.category === "tenant" && g.severity === "P0")
            .every((g) => g.rows.length === 0),
          orphanAuth: final.integrity.filter((g) => g.category === "auth" && g.severity === "P0").every((g) => g.rows.length === 0),
          onboardingCritical: final.integrity.filter((g) => g.category === "onboarding" && g.severity === "P0").every((g) => g.rows.length === 0),
          websiteCritical: final.integrity.filter((g) => g.category === "website" && g.severity === "P0").every((g) => g.rows.length === 0),
        },
      },
      null,
      2,
    ),
  );

  // Report-only is deliberately non-blocking so operators can inspect counts
  // before any mutation. CI blocks P0 issues; --strict also blocks P1/P2.
  if (!reportOnly && ci) {
    const blocking = strict
      ? summary.P0 + summary.P1 + summary.P2 + legacyTotal
      : summary.P0;
    if (blocking > 0) {
      console.error(`[data:audit] CI gate failed with ${blocking} blocking integrity finding(s)`);
      process.exitCode = 2;
    }
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
