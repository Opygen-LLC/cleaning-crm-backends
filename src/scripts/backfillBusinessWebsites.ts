import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma/prisma";
import { WebsiteProvisioningService } from "../modules/Website/websiteProvisioning.service";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BATCH_SIZE = 500;
const MAX_FAILURE_SAMPLES = 50;
export const LEGACY_WEBSITE_INITIAL_REVISION_REASON = "Existing customer website provisioned";

export interface WebsiteBackfillOptions {
  dryRun: boolean;
  batchSize: number;
  maxAttempts: number;
}

export interface WebsiteBackfillResult {
  scanned: number;
  created: number;
  alreadyProvisioned: number;
  failed: number;
  failedAdminIds: string[];
}

const positiveInt = (
  value: string | undefined,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
};

export const parseWebsiteBackfillArgs = (argv: string[] = process.argv.slice(2)): WebsiteBackfillOptions => {
  let dryRun = false;
  let batchSize = positiveInt(process.env.WEBSITE_BACKFILL_BATCH_SIZE, DEFAULT_BATCH_SIZE, {
    max: MAX_BATCH_SIZE,
  });
  let maxAttempts = positiveInt(process.env.WEBSITE_BACKFILL_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, {
    max: 5,
  });

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    if (arg.startsWith("--batch-size=")) {
      batchSize = positiveInt(arg.split("=", 2)[1], batchSize, { max: MAX_BATCH_SIZE });
    }
    if (arg.startsWith("--max-attempts=")) {
      maxAttempts = positiveInt(arg.split("=", 2)[1], maxAttempts, { max: 5 });
    }
  }

  return { dryRun, batchSize, maxAttempts };
};

const provisionWithRetry = async (
  admin: { id: string; userId: string; businessName: string },
  maxAttempts: number,
) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await WebsiteProvisioningService.provisionDefaultWebsiteForAdmin({
        adminId: admin.id,
        businessName: admin.businessName,
        createdByUserId: admin.userId,
        initialRevisionReason: LEGACY_WEBSITE_INITIAL_REVISION_REASON,
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        // Small bounded delay is enough to recover from short DB/network
        // interruptions without turning this data migration into a long-running
        // retry loop. Rerunning the script is always safe because provisioning
        // is idempotent per AdminProfile.
        await sleep(100 * attempt);
      }
    }
  }

  throw lastError;
};

/**
 * Phase 21 idempotent data migration for existing Cleaning CRM customers.
 *
 * Safety properties:
 * - Only AdminProfiles without a BusinessWebsite are selected.
 * - Every tenant is provisioned in its own transaction.
 * - Provisioning creates the default template/pages and Revision #1, but never
 *   publishes: status remains PROVISIONED and publishedSnapshot stays null.
 * - Subdomain allocation uses the same advisory-locked allocator as new
 *   registrations, so a backfill worker cannot steal another tenant's hostname.
 * - Cursor pagination prevents one failing tenant from causing an infinite
 *   loop in the current run.
 * - A rerun naturally retries only tenants that still have no website.
 */
export const runWebsiteBackfill = async (
  options: WebsiteBackfillOptions = parseWebsiteBackfillArgs(),
): Promise<WebsiteBackfillResult> => {
  let cursor: string | undefined;
  let scanned = 0;
  let created = 0;
  let alreadyProvisioned = 0;
  let failed = 0;
  const failedAdminIds: string[] = [];

  for (;;) {
    const admins = await prisma.adminProfile.findMany({
      where: {
        businessWebsite: { is: null },
      },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        businessName: true,
      },
      orderBy: { id: "asc" },
      take: options.batchSize,
    });

    if (admins.length === 0) break;

    for (const admin of admins) {
      cursor = admin.id;
      scanned += 1;

      if (options.dryRun) {
        process.stdout.write(`[dry-run] Missing website: admin ${admin.id} (${admin.businessName})\n`);
        continue;
      }

      try {
        const result = await provisionWithRetry(admin, options.maxAttempts);
        if (result.created) {
          created += 1;
          process.stdout.write(
            `Provisioned unpublished website for admin ${admin.id} at subdomain ${result.website.subdomain}\n`,
          );
        } else {
          // A concurrent registration/repair worker may have provisioned the
          // tenant after this batch was selected. Treat that as success.
          alreadyProvisioned += 1;
        }
      } catch (error) {
        failed += 1;
        if (failedAdminIds.length < MAX_FAILURE_SAMPLES) failedAdminIds.push(admin.id);
        console.error(`Failed to provision website for admin ${admin.id}`, error);
      }
    }
  }

  const result: WebsiteBackfillResult = {
    scanned,
    created,
    alreadyProvisioned,
    failed,
    failedAdminIds,
  };

  process.stdout.write(
    `Website backfill complete. scanned=${scanned} created=${created} ` +
      `alreadyProvisioned=${alreadyProvisioned} failed=${failed} dryRun=${options.dryRun}\n`,
  );

  return result;
};

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (isDirectExecution) {
  runWebsiteBackfill()
    .then((result) => {
      // A non-zero exit status is important for deployment tooling: partial
      // success is resumable, but it must not be reported as a fully successful
      // migration when one or more tenants remain unprovisioned.
      if (result.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(
        "Website backfill failed before completion. Rerun after fixing the reported error; completed tenants are safe.",
        error,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}
