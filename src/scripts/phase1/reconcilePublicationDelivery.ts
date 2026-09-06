import { pathToFileURL } from "node:url";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteCacheOutbox } from "../../lib/outbox/publicWebsiteCacheOutbox";
import { parsePublishedSnapshot } from "../../modules/Website/websiteSnapshot";

/** Read-only by default. Publication/revision/onboarding are NEVER changed.
 * --apply schedules verification of the already committed immutable revision
 * through the existing lifecycle outbox, after an operator reviews the report.
 * Run after the Phase 5 migration and after upgrading all API/worker writers. */
export const reconcilePublicationDelivery = async (args = process.argv.slice(2)) => {
  if (args.some(arg => !["--apply", "--dry-run", "--retry-dead"].includes(arg) && !/^--batch-size=\d+$/.test(arg)) ||
      (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("Usage: reconcilePublicationDelivery [--dry-run | --apply] [--retry-dead] [--batch-size=100]");
  const apply = args.includes("--apply"), retryDead = args.includes("--retry-dead");
  const size = Number(args.find(arg => arg.startsWith("--batch-size="))?.split("=")[1] ?? 100);
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error("Batch size must be 1..500");
  const report = { mode: apply ? "apply" : "dry-run", scanned: 0, healthy: 0, pending: 0, missing: 0, dead: 0, invalid: 0, changed: 0, enqueued: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.businessWebsite.findMany({ where: { status: "PUBLISHED" }, select: { id: true }, orderBy: { id: "asc" }, take: size,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!batch.length) break;
    for (const candidate of batch) {
      cursor = candidate.id; report.scanned++;
      try {
        const outcome = await prisma.$transaction(async tx => {
          await acquireTextTransactionAdvisoryLock(tx, candidate.id);
          const website = await tx.businessWebsite.findUnique({ where: { id: candidate.id }, select: {
            id: true, adminId: true, status: true, publishedAt: true, publishedRevisionNumber: true, draftRevisionNumber: true,
            publishedSnapshot: true, publicationDeliveryEventId: true, publicationDeliveryReceipt: true,
          } });
          if (!website || website.status !== "PUBLISHED") return "changed" as const;
          const revision = website.publishedRevisionNumber;
          if (!revision || !website.publishedAt || website.draftRevisionNumber < revision || !parsePublishedSnapshot(website.publishedSnapshot)) return "invalid" as const;
          if (!await tx.websiteRevision.findFirst({ where: { websiteId: website.id, revisionNumber: revision }, select: { id: true } })) return "invalid" as const;
          const proof = website.publicationDeliveryReceipt as Record<string, unknown> | null;
          if (website.publicationDeliveryEventId && proof?.delivered === true && proof.revision === revision) return "healthy" as const;
          const event = website.publicationDeliveryEventId ? await tx.outboxEvent.findUnique({
            where: { id: website.publicationDeliveryEventId }, select: { id: true, status: true, lockedAt: true },
          }) : null;
          if (event && ["PENDING", "RETRY", "PROCESSING"].includes(event.status)) return "pending" as const;
          if (event?.status === "DEAD" && (!apply || !retryDead)) return "dead" as const;
          if (!apply) return "missing" as const;
          // A fresh lifecycle verification event has the current row identity;
          // it does not invent a new publication or replay stale tenant data.
          await PublicWebsiteCacheOutbox.enqueueTenantDeliveryTx(tx, website.adminId, "phase5-verify-existing-publication");
          return "enqueued" as const;
        }, { maxWait: 10_000, timeout: 30_000 });
        report[outcome]++;
        process.stdout.write(JSON.stringify({ websiteId: candidate.id, outcome, mode: report.mode }) + "\n");
      } catch {
        report.failed++;
        process.stderr.write(JSON.stringify({ websiteId: candidate.id, outcome: "failed" }) + "\n");
      }
    }
  }
  process.stdout.write(JSON.stringify({ summary: report }) + "\n");
  return report;
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reconcilePublicationDelivery().then(report => { if (report.failed || report.invalid || report.dead) process.exitCode = 1; })
    .catch(() => { console.error("Publication reconciliation failed; verify migration and database access"); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });
}
