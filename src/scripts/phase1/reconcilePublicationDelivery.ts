import { pathToFileURL } from "node:url";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteCacheOutbox, publicationDeliveryDedupeKey } from "../../lib/outbox/publicWebsiteCacheOutbox";
import { parsePublishedSnapshot } from "../../modules/Website/websiteSnapshot";

/** Defaults to read-only. Never publishes, creates a website, or completes onboarding. */
export const reconcilePublicationDelivery = async (args = process.argv.slice(2)) => {
  const allowed = args.every((arg) => arg === "--apply" || arg === "--dry-run" || arg === "--retry-dead" || /^--batch-size=\d+$/.test(arg));
  if (!allowed || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("Usage: reconcilePublicationDelivery [--dry-run | --apply] [--retry-dead] [--batch-size=100]");
  }
  const apply = args.includes("--apply");
  const retryDead = args.includes("--retry-dead");
  const size = Number(args.find((arg) => arg.startsWith("--batch-size="))?.split("=")[1] ?? 100);
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error("Batch size must be 1..500");
  const report = { mode: apply ? "apply" : "dry-run", scanned: 0, healthy: 0, missing: 0, dead: 0, invalid: 0, changed: 0, enqueued: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.businessWebsite.findMany({
      where: { status: "PUBLISHED" }, select: { id: true }, orderBy: { id: "asc" }, take: size,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!batch.length) break;
    for (const candidate of batch) {
      cursor = candidate.id;
      report.scanned += 1;
      try {
        // Share the publication lock. The receipt must correspond to the exact
        // row/revision inspected, even if an editor publishes during this scan.
        const outcome = await prisma.$transaction(async (tx) => {
          await acquireTextTransactionAdvisoryLock(tx, candidate.id);
          const website = await tx.businessWebsite.findUnique({
            where: { id: candidate.id },
            select: {
              id: true, adminId: true, status: true, subdomain: true,
              publishedAt: true, publishedRevisionNumber: true, draftRevisionNumber: true, publishedSnapshot: true,
              subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } },
            },
          });
          if (!website || website.status !== "PUBLISHED") return "changed" as const;
          const revision = website.publishedRevisionNumber;
          if (!revision || !website.publishedAt || website.draftRevisionNumber < revision || !parsePublishedSnapshot(website.publishedSnapshot)) {
            return "invalid" as const;
          }
          const revisionRow = await tx.websiteRevision.findFirst({
            where: { websiteId: website.id, revisionNumber: revision }, select: { id: true },
          });
          if (!revisionRow) return "invalid" as const;
          const receipt = await tx.outboxEvent.findUnique({
            where: { dedupeKey: publicationDeliveryDedupeKey(website.id, revision) }, select: { id: true, status: true },
          });
          if (receipt?.status === "DEAD") {
            if (apply && retryDead) {
              const retried = await tx.outboxEvent.updateMany({
                where: { id: receipt.id, status: "DEAD", lockedAt: null },
                data: { status: "PENDING", attempts: 0, processedAt: null, nextAttemptAt: new Date(), lastError: null },
              });
              return retried.count === 1 ? "enqueued" as const : "dead" as const;
            }
            return "dead" as const;
          }
          if (receipt) return "healthy" as const;
          if (!apply) return "missing" as const;
          await PublicWebsiteCacheOutbox.enqueuePublicationTx(tx, {
            websiteId: website.id,
            tenantIdentifier: website.subdomain,
            tenantIdentifiers: [website.subdomain, ...website.subdomainAliases.map((a) => a.subdomain), ...website.domains.map((d) => d.domain)],
            publication: { adminId: website.adminId, revisionNumber: revision },
            reason: "phase1-existing-publication-delivery",
          });
          return "enqueued" as const;
        }, { maxWait: 10_000, timeout: 30_000 });
        report[outcome] += 1;
        process.stdout.write(JSON.stringify({ websiteId: candidate.id, outcome, mode: report.mode }) + "\n");
      } catch {
        report.failed += 1;
        // No connection string, SQL, snapshot, owner details or credentials.
        process.stderr.write(JSON.stringify({ websiteId: candidate.id, outcome: "failed" }) + "\n");
      }
    }
  }
  process.stdout.write(JSON.stringify({ summary: report }) + "\n");
  return report;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reconcilePublicationDelivery().then((report) => {
    if (report.failed || report.invalid || report.dead) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Publication reconciliation failed");
    process.exitCode = 1;
  }).finally(async () => { await prisma.$disconnect(); });
}
