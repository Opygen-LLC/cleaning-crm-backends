import { prisma } from "../../lib/prisma/prisma";
import { PublicDocumentLinkService } from "../../modules/Website/publicDocumentLink.service";

const applyFixes = process.argv.includes("--fix");

type ResourceType = "quote" | "estimate";
type Issue = {
  code: string;
  resourceType: ResourceType;
  id: string;
  ref: string;
  adminId: string;
  detail: string;
  fixed: boolean;
};

const issues: Issue[] = [];
const tokenRe = /^[A-Za-z0-9_-]{43}$/;

const record = (issue: Issue) => {
  issues.push(issue);
  const marker = issue.fixed ? "FIXED" : "REPORT";
  console.log(`[${marker}] ${issue.code} ${issue.resourceType}:${issue.ref} ${issue.detail}`);
};

const resolveTenant = async (resourceType: ResourceType, row: { id: string; ref: string; adminId: string }) => {
  try {
    return await PublicDocumentLinkService.resolveForAdmin(row.adminId);
  } catch (error) {
    record({
      code: "PUBLIC_DOCUMENT_TENANT_URL_UNAVAILABLE",
      resourceType,
      id: row.id,
      ref: row.ref,
      adminId: row.adminId,
      detail: error instanceof Error ? error.message : String(error),
      fixed: false,
    });
    return null;
  }
};

const reconcileQuote = async (quote: {
  id: string;
  quoteRef: string;
  adminId: string;
  status: string;
  publicToken: string | null;
  publishedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => {
  const resourceType = "quote" as const;
  const base = { id: quote.id, ref: quote.quoteRef, adminId: quote.adminId };

  if (quote.status === "DRAFT") {
    if (quote.publicToken || quote.publishedAt || quote.sentAt) {
      if (applyFixes) {
        await prisma.quote.update({
          where: { id: quote.id },
          data: { publicToken: null, publishedAt: null, sentAt: null },
        });
      }
      record({
        ...base,
        resourceType,
        code: "DRAFT_PUBLIC_CAPABILITY_PRESENT",
        detail: "Draft contained publicToken/publishedAt/sentAt and must remain private.",
        fixed: applyFixes,
      });
    }
    return;
  }

  const tenant = await resolveTenant(resourceType, base);
  if (!tenant) return;

  const invalidToken = Boolean(quote.publicToken && !tokenRe.test(quote.publicToken));
  const needsToken = !quote.publicToken || invalidToken;
  const needsPublishedAt = !quote.publishedAt;

  // SENT is also the backward-compatible persisted status for PUBLISH. A null
  // sentAt therefore means "published, not emailed" and must never be invented
  // by reconciliation. Pre-Phase-2 SENT rows are backfilled by the migration.
  if (needsToken || needsPublishedAt) {
    let token = quote.publicToken;
    if (applyFixes && needsToken) token = await PublicDocumentLinkService.generateUniqueToken();
    if (applyFixes) {
      const publishedAt = quote.publishedAt ?? quote.sentAt ?? quote.updatedAt ?? quote.createdAt;
      await prisma.quote.update({
        where: { id: quote.id },
        data: {
          ...(needsToken ? { publicToken: token } : {}),
          ...(needsPublishedAt ? { publishedAt } : {}),
        },
      });
    }
    record({
      ...base,
      resourceType,
      code: invalidToken ? "PUBLIC_TOKEN_INVALID" : "PUBLICATION_INVARIANT_INCOMPLETE",
      detail: `token=${quote.publicToken ? (invalidToken ? "invalid" : "present") : "missing"}, publishedAt=${quote.publishedAt ? "present" : "missing"}, sentAt=${quote.sentAt ? "present" : "missing"}`,
      fixed: applyFixes,
    });
  }
};

const reconcileEstimate = async (estimate: {
  id: string;
  estimateRef: string;
  adminId: string;
  status: string;
  publicToken: string | null;
  publishedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => {
  const resourceType = "estimate" as const;
  const base = { id: estimate.id, ref: estimate.estimateRef, adminId: estimate.adminId };

  if (estimate.status === "DRAFT") {
    if (estimate.publicToken || estimate.publishedAt || estimate.sentAt) {
      if (applyFixes) {
        await prisma.estimate.update({
          where: { id: estimate.id },
          data: { publicToken: null, publishedAt: null, sentAt: null },
        });
      }
      record({
        ...base,
        resourceType,
        code: "DRAFT_PUBLIC_CAPABILITY_PRESENT",
        detail: "Draft contained publicToken/publishedAt/sentAt and must remain private.",
        fixed: applyFixes,
      });
    }
    return;
  }

  const tenant = await resolveTenant(resourceType, base);
  if (!tenant) return;

  const invalidToken = Boolean(estimate.publicToken && !tokenRe.test(estimate.publicToken));
  const needsToken = !estimate.publicToken || invalidToken;
  const needsPublishedAt = !estimate.publishedAt;

  // SENT is also the backward-compatible persisted status for PUBLISH. A null
  // sentAt therefore means "published, not emailed" and must never be invented
  // by reconciliation. Pre-Phase-2 SENT rows are backfilled by the migration.
  if (needsToken || needsPublishedAt) {
    let token = estimate.publicToken;
    if (applyFixes && needsToken) token = await PublicDocumentLinkService.generateUniqueToken();
    if (applyFixes) {
      const publishedAt = estimate.publishedAt ?? estimate.sentAt ?? estimate.updatedAt ?? estimate.createdAt;
      await prisma.estimate.update({
        where: { id: estimate.id },
        data: {
          ...(needsToken ? { publicToken: token } : {}),
          ...(needsPublishedAt ? { publishedAt } : {}),
        },
      });
    }
    record({
      ...base,
      resourceType,
      code: invalidToken ? "PUBLIC_TOKEN_INVALID" : "PUBLICATION_INVARIANT_INCOMPLETE",
      detail: `token=${estimate.publicToken ? (invalidToken ? "invalid" : "present") : "missing"}, publishedAt=${estimate.publishedAt ? "present" : "missing"}, sentAt=${estimate.sentAt ? "present" : "missing"}`,
      fixed: applyFixes,
    });
  }
};

const run = async () => {
  console.log(`Public document reconciliation mode: ${applyFixes ? "FIX" : "REPORT-ONLY"}`);
  const [quotes, estimates] = await Promise.all([
    prisma.quote.findMany({
      select: {
        id: true, quoteRef: true, adminId: true, status: true, publicToken: true,
        publishedAt: true, sentAt: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.estimate.findMany({
      select: {
        id: true, estimateRef: true, adminId: true, status: true, publicToken: true,
        publishedAt: true, sentAt: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  for (const quote of quotes) await reconcileQuote({ ...quote, status: String(quote.status) });
  for (const estimate of estimates) await reconcileEstimate({ ...estimate, status: String(estimate.status) });

  const quoteTokens = new Map<string, string>();
  for (const quote of quotes) if (quote.publicToken) quoteTokens.set(quote.publicToken, quote.quoteRef);
  for (const estimate of estimates) {
    if (!estimate.publicToken) continue;
    const quoteRef = quoteTokens.get(estimate.publicToken);
    if (!quoteRef) continue;
    record({
      code: "CROSS_RESOURCE_TOKEN_COLLISION",
      resourceType: "estimate",
      id: estimate.id,
      ref: estimate.estimateRef,
      adminId: estimate.adminId,
      detail: `Token also belongs to quote ${quoteRef}. This is reported only because rotating an already-shared capability can invalidate a client link.`,
      fixed: false,
    });
  }

  const summary = issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.code] = (acc[issue.code] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ mode: applyFixes ? "fix" : "report", totalIssues: issues.length, summary }, null, 2));
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
