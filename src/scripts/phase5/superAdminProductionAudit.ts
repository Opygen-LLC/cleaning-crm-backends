import { prisma } from "../../lib/prisma/prisma";

const now = new Date();
const staleCutoff = new Date(now.getTime() - 5 * 60 * 1000);

const main = async () => {
  const [pendingDeletion, failedDeletion, staleDeletion, recentDeleteFailures] = await Promise.all([
    prisma.adminProfile.count({ where: { lifecycleStatus: "PENDING_DELETION" as never } }),
    prisma.adminProfile.count({ where: { lifecycleStatus: "PENDING_DELETION" as never, deletionLastError: { not: null } } }),
    prisma.adminProfile.count({ where: { lifecycleStatus: "PENDING_DELETION" as never, deletionLastError: null, deletionLastAttemptAt: { lt: staleCutoff } } }),
    prisma.superAdminAuditLog.count({ where: { action: "TENANT_HARD_DELETE_FAILED", createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }),
  ]);

  const report = { checkedAt: now.toISOString(), pendingDeletion, failedDeletion, staleDeletion, hardDeleteFailuresLast24h: recentDeleteFailures };
  console.log(JSON.stringify(report, null, 2));
  if (staleDeletion > 0) process.exitCode = 2;
};

main().catch((error) => {
  console.error("Phase 5 production audit failed", error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
