import { pathToFileURL } from "node:url";
import { AccountStatus, UserRole } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { AccountIntegrityService } from "../../modules/Auth/accountIntegrity.service";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_FAILURE_SAMPLES = 50;

export interface ProvisioningReconciliationOptions {
  dryRun: boolean;
  batchSize: number;
  userId?: string;
}

export interface ProvisioningReconciliationResult {
  scanned: number;
  healthy: number;
  repaired: number;
  failed: number;
  issueCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  failedUserIds: string[];
}

const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_BATCH_SIZE ? parsed : fallback;
};

export const parseProvisioningReconciliationArgs = (
  argv = process.argv.slice(2),
): ProvisioningReconciliationOptions => {
  let dryRun = false;
  let batchSize = positiveInt(process.env.PROVISIONING_RECONCILIATION_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  let userId: string | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--batch-size=")) batchSize = positiveInt(arg.split("=", 2)[1], batchSize);
    else if (arg.startsWith("--user-id=")) userId = arg.split("=", 2)[1]?.trim() || undefined;
  }

  return { dryRun, batchSize, userId };
};

const bump = (target: Record<string, number>, keys: string[]) => {
  for (const key of keys) target[key] = (target[key] ?? 0) + 1;
};

/**
 * Audits/repairs only verified ACTIVE ADMIN users. Other user states are never
 * changed by this release job. Rerunning after a successful repair converges
 * to a read-only healthy result.
 */
export const runProvisioningReconciliation = async (
  options = parseProvisioningReconciliationArgs(),
): Promise<ProvisioningReconciliationResult> => {
  const result: ProvisioningReconciliationResult = {
    scanned: 0,
    healthy: 0,
    repaired: 0,
    failed: 0,
    issueCounts: {},
    actionCounts: {},
    failedUserIds: [],
  };

  let cursor: string | undefined;
  for (;;) {
    const users = await prisma.user.findMany({
      where: {
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        ...(options.userId ? { id: options.userId } : {}),
      },
      ...(cursor && !options.userId ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
      orderBy: { id: "asc" },
      take: options.userId ? 1 : options.batchSize,
    });
    if (users.length === 0) break;

    for (const user of users) {
      cursor = user.id;
      result.scanned += 1;
      try {
        const audit = await AccountIntegrityService.inspectActiveAdminProvisioning(user.id);
        bump(result.issueCounts, audit.issues);

        if (audit.healthy) {
          result.healthy += 1;
          process.stdout.write(`${options.dryRun ? "[dry-run] " : ""}user=${user.id} healthy\n`);
          continue;
        }

        if (options.dryRun) {
          process.stdout.write(`[dry-run] user=${user.id} issues=${audit.issues.join(",")}\n`);
          continue;
        }

        const repaired = await AccountIntegrityService.repairActiveAdminProvisioning(user.id);
        bump(result.actionCounts, repaired.actions);
        if (repaired.repaired) result.repaired += 1;
        else result.healthy += 1;
        process.stdout.write(`user=${user.id} actions=${repaired.actions.join(",") || "none"}\n`);
      } catch (error) {
        result.failed += 1;
        if (result.failedUserIds.length < MAX_FAILURE_SAMPLES) result.failedUserIds.push(user.id);
        console.error(`Provisioning reconciliation failed for user ${user.id}`, error);
      }
    }

    if (options.userId) break;
  }

  process.stdout.write(
    `Provisioning reconciliation complete. scanned=${result.scanned} healthy=${result.healthy} repaired=${result.repaired} failed=${result.failed} dryRun=${options.dryRun}\n`,
  );

  return result;
};

const isDirectExecution = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isDirectExecution) {
  runProvisioningReconciliation()
    .then((result) => {
      if (result.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error("Provisioning reconciliation aborted", error);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect().catch(() => {}));
}
