import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publication = readFileSync(new URL("../modules/Website/publicDocumentPublication.service.ts", import.meta.url), "utf8");
const quoteService = readFileSync(new URL("../modules/Quote/quote.service.ts", import.meta.url), "utf8");
const estimateService = readFileSync(new URL("../modules/Estimate/estimate.service.ts", import.meta.url), "utf8");
const reconciliation = readFileSync(new URL("../scripts/phase2/reconcilePublicDocuments.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../prisma/schema/quote.prisma", import.meta.url), "utf8");

const count = (source: string, needle: string) => source.split(needle).length - 1;

describe("Phase 2 public document publication contract", () => {
  it("centralizes draft/publish/send semantics and preflights the tenant URL", () => {
    expect(publication).toContain('PublicDocumentDeliveryIntent = "DRAFT" | "PUBLISH" | "SEND"');
    expect(publication).toContain("PublicDocumentLinkService.resolveForAdmin");
    expect(publication).toContain('deliveryIntent === "SEND" ? now : null');
    expect(publication).toContain("publishedAt");
  });

  it("does not allocate tokens for newly-created drafts", () => {
    expect(publication).toContain('if (deliveryIntent === "DRAFT")');
    expect(publication).toContain("publicToken: null");
    expect(quoteService).not.toContain("ensurePublicQuoteToken");
  });

  it("routes both status=SENT and explicit share through the canonical publication service", () => {
    expect(count(quoteService, "PublicDocumentPublicationService.publishQuote")).toBeGreaterThanOrEqual(3);
    expect(count(estimateService, "PublicDocumentPublicationService.publishEstimate")).toBeGreaterThanOrEqual(3);
  });

  it("queues SEND email work transactionally", () => {
    expect(quoteService).toContain("queueQuoteSentNotificationTx");
    expect(estimateService).toContain("queueEstimateSentNotificationTx");
    expect(publication).toContain("onPublishedTx");
  });

  it("persists publication timestamps and ships a report-first reconciliation tool", () => {
    expect(count(schema, "publishedAt")).toBe(2);
    expect(reconciliation).toContain('const applyFixes = process.argv.includes("--fix")');
    expect(reconciliation).toContain("DRAFT_PUBLIC_CAPABILITY_PRESENT");
    expect(reconciliation).toContain("PUBLICATION_INVARIANT_INCOMPLETE");
    expect(reconciliation).toContain("CROSS_RESOURCE_TOKEN_COLLISION");
    expect(reconciliation).not.toContain("needsLegacySentAt");
  });
});
