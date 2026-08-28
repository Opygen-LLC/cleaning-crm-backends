import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma/prisma";
import { WebsiteReleaseMigrationService } from "../modules/Website/websiteReleaseMigration.service";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

const readPositiveInt = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
};

export interface Phase10WebsiteMigrationOptions {
  dryRun: boolean;
  batchSize: number;
}

export interface Phase10WebsiteMigrationResult {
  scanned: number;
  healthy: number;
  created: number;
  repaired: number;
  failed: number;
  issueCounts: Record<string, number>;
  failedAdminIds: string[];
}

export const parsePhase10WebsiteMigrationArgs = (argv = process.argv.slice(2)): Phase10WebsiteMigrationOptions => {
  let dryRun = false;
  let batchSize = readPositiveInt(process.env.WEBSITE_RELEASE_BATCH_SIZE, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    if (arg.startsWith("--batch-size=")) {
      batchSize = readPositiveInt(arg.split("=", 2)[1], batchSize, MAX_BATCH_SIZE);
    }
  }
  return { dryRun, batchSize };
};

const bumpIssues = (target: Record<string, number>, issues: string[]) => {
  for (const issue of issues) target[issue] = (target[issue] ?? 0) + 1;
};

/**
 * Phase 10 rolling-release migration.
 *
 * - Scans every AdminProfile, not only admins missing a website.
 * - Dry-run is read-only and reports structural issues.
 * - Apply mode repairs one tenant per transaction; a single bad tenant cannot
 *   roll back customers already repaired in previous batches.
 * - It never publishes PROVISIONED/DRAFT sites and never overwrites healthy
 *   page content. Rerunning is safe and converges to a no-op.
 */
export const runPhase10WebsiteMigration = async (
  options: Phase10WebsiteMigrationOptions = parsePhase10WebsiteMigrationArgs(),
): Promise<Phase10WebsiteMigrationResult> => {
  const result: Phase10WebsiteMigrationResult = {
    scanned: 0,
    healthy: 0,
    created: 0,
    repaired: 0,
    failed: 0,
    issueCounts: {},
    failedAdminIds: [],
  };

  let cursor: string | undefined;
  for (;;) {
    const admins = await prisma.adminProfile.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, userId: true, businessName: true },
      orderBy: { id: "asc" },
      take: options.batchSize,
    });
    if (admins.length === 0) break;

    for (const admin of admins) {
      cursor = admin.id;
      result.scanned += 1;
      try {
        if (options.dryRun) {
          const audit = await WebsiteReleaseMigrationService.auditAdminWebsiteForRelease(admin.id);
          bumpIssues(result.issueCounts, audit.issues);
          if (audit.healthy) result.healthy += 1;
          process.stdout.write(`[dry-run] admin=${admin.id} ${audit.healthy ? "healthy" : audit.issues.join(",")}\n`);
          continue;
        }

        const repaired = await WebsiteReleaseMigrationService.reconcileAdminWebsiteForRelease({
          adminId: admin.id,
          userId: admin.userId,
          businessName: admin.businessName,
        });
        bumpIssues(result.issueCounts, repaired.detectedIssues);
        if (repaired.created) result.created += 1;
        else if (repaired.repaired) result.repaired += 1;
        else result.healthy += 1;
        process.stdout.write(
          `admin=${admin.id} website=${repaired.websiteId ?? "none"} actions=${repaired.actions.join(",") || "none"}\n`,
        );
      } catch (error) {
        result.failed += 1;
        if (result.failedAdminIds.length < 50) result.failedAdminIds.push(admin.id);
        console.error(`Phase 10 website migration failed for admin ${admin.id}`, error);
      }
    }
  }

  process.stdout.write(
    `Phase 10 website migration complete. scanned=${result.scanned} healthy=${result.healthy} created=${result.created} repaired=${result.repaired} failed=${result.failed} dryRun=${options.dryRun}\n`,
  );
  return result;
};

const isDirectExecution = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isDirectExecution) {
  runPhase10WebsiteMigration()
    .then((result) => {
      if (result.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error("Phase 10 website migration aborted", error);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect().catch(() => {}));
}
