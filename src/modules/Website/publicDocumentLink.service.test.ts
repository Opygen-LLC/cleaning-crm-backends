import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, tenantUrlMock } = vi.hoisted(() => ({
  prismaMock: {
    quote: { findUnique: vi.fn(), findFirst: vi.fn() },
    estimate: { findUnique: vi.fn(), findFirst: vi.fn() },
    businessWebsite: { findUnique: vi.fn() },
  },
  tenantUrlMock: {
    resolveForAdminId: vi.fn(),
    buildRootDocumentUrl: vi.fn((resolution: { origin: string }, token: string) => `${resolution.origin}/${token}`),
  },
}));

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("./tenantPublicUrl.service", () => ({ TenantPublicUrlService: tenantUrlMock }));
vi.mock("../../generated/prisma/enums", () => ({
  QuoteStatus: { DRAFT: "DRAFT" },
  EstimateStatus: { DRAFT: "DRAFT" },
}));

import { PublicDocumentLinkService } from "./publicDocumentLink.service";

const TOKEN = "D".repeat(43);
const WEBSITE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  tenantUrlMock.resolveForAdminId.mockResolvedValue({
    websiteId: WEBSITE_ID,
    subdomain: "tenant-a",
    origin: "https://tenant-a.cleaningcrm.opygen.com",
  });
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ adminId: "admin-a" });
});

describe("PublicDocumentLinkService", () => {
  it("builds quote and estimate URLs through the same canonical tenant resolver", async () => {
    const quoteUrl = await PublicDocumentLinkService.buildPublicDocumentUrl({ adminId: "admin-a", resourceType: "quote", token: TOKEN });
    const estimateUrl = await PublicDocumentLinkService.buildPublicDocumentUrl({ adminId: "admin-a", resourceType: "estimate", token: TOKEN });
    expect(quoteUrl).toBe(`https://tenant-a.cleaningcrm.opygen.com/${TOKEN}`);
    expect(estimateUrl).toBe(quoteUrl);
    expect(tenantUrlMock.resolveForAdminId).toHaveBeenCalledTimes(2);
  });

  it("resolves a tenant-bound estimate token without returning customer data", async () => {
    prismaMock.quote.findFirst.mockResolvedValue(null);
    prismaMock.estimate.findFirst.mockResolvedValue({ id: "estimate-1" });
    await expect(PublicDocumentLinkService.resolveResourceTypeForWebsite(TOKEN, WEBSITE_ID)).resolves.toBe("estimate");
    expect(prismaMock.estimate.findFirst).toHaveBeenCalledWith({
      where: { publicToken: TOKEN, adminId: "admin-a", status: { not: "DRAFT" }, publishedAt: { not: null } },
      select: { id: true },
    });
  });

  it("fails closed if a token resolves in both root-token tables", async () => {
    prismaMock.quote.findFirst.mockResolvedValue({ id: "quote-1" });
    prismaMock.estimate.findFirst.mockResolvedValue({ id: "estimate-1" });
    await expect(PublicDocumentLinkService.resolveResourceTypeForWebsite(TOKEN, WEBSITE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_DOCUMENT_NOT_FOUND",
    });
  });
});
