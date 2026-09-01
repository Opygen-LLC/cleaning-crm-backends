import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  transactionQuoteMock,
  getAdminIdMock,
  createNotificationMock,
  queueQuoteSentNotificationMock,
  tenantPublicUrlMock,
  publicationMock,
} = vi.hoisted(() => {
  const transactionQuoteMock = {
    findFirst: vi.fn(),
    update: vi.fn(),
  };

  return {
    transactionQuoteMock,
    prismaMock: {
      quote: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      estimate: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      businessWebsite: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ quote: transactionQuoteMock }),
      ),
    },
    getAdminIdMock: vi.fn(),
    createNotificationMock: vi.fn(),
    queueQuoteSentNotificationMock: vi.fn(),
    publicationMock: {
      prepareCreation: vi.fn(),
      publishQuote: vi.fn(),
    },
    tenantPublicUrlMock: {
      resolveForAdminId: vi.fn(),
      buildRootDocumentUrl: vi.fn(
        (resolution: { origin: string }, token: string) =>
          `${resolution.origin.replace(/\/+$/, "")}/${token}`,
      ),
      buildRootDocumentUrlForAdmin: vi.fn(),
    },
  };
});

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("../../lib/validation/phone", () => ({ requireE164Phone: vi.fn() }));
vi.mock("../../generated/prisma/enums", () => ({
  NotificationType: { QUOTE: "QUOTE" },
  EstimateStatus: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    CONVERTED: "CONVERTED",
  },
  QuoteStatus: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    ACCEPTED: "ACCEPTED",
    DECLINED: "DECLINED",
    EXPIRED: "EXPIRED",
  },
}));
vi.mock("../../lib/utils/QueryBuilder", () => ({
  QueryBuilder: class QueryBuilder {},
}));
vi.mock("../../lib/utils/createNotification", () => ({
  createNotification: createNotificationMock,
}));
vi.mock("../../lib/utils/referenceNumber", () => ({ nextReference: vi.fn() }));
vi.mock("../../lib/utils/serviceIdentity", () => ({
  inferLegacyServiceType: vi.fn(),
  resolveFlexibleServiceIdentity: vi.fn(),
  serviceDisplayName: vi.fn(),
}));
vi.mock("../../lib/utils/checkPlanLimits", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("../../lib/notifications/businessNotificationEvents", () => ({
  queueQuoteSentNotificationTx: queueQuoteSentNotificationMock,
}));
vi.mock("../Website/tenantPublicUrl.service", () => ({
  TenantPublicUrlService: tenantPublicUrlMock,
}));
vi.mock("../Website/publicDocumentPublication.service", () => ({
  PublicDocumentPublicationService: publicationMock,
}));

import AppError from "../../errorHelper/AppError";
import { quoteService } from "./quote.service";

const TOKEN = "A".repeat(43);
const WEBSITE_ID = "11111111-1111-4111-8111-111111111111";
const NOW_FUTURE = () => new Date(Date.now() + 60_000);
const NOW_PAST = () => new Date(Date.now() - 60_000);

const publicQuote = (status: string, validUntil = NOW_FUTURE()) => ({
  id: "quote-1",
  quoteRef: "#OP-QT-1",
  status,
  serviceCatalogId: null,
  serviceNameSnapshot: "Deep clean",
  serviceCatalog: null,
  serviceType: null,
  address: "1 Example Street",
  subtotal: 100,
  taxRate: 0,
  tax: 0,
  total: 100,
  validUntil,
  notes: null,
  publishedAt: new Date(),
  sentAt: new Date(),
  respondedAt: null,
  responseNote: null,
  createdAt: new Date(),
  lineItems: [],
  admin: {
    businessName: "Softriple Cleaning",
    businessEmail: "hello@example.com",
    businessLogo: null,
    brandColor: null,
    currency: "USD",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  tenantPublicUrlMock.resolveForAdminId.mockResolvedValue({
    websiteId: WEBSITE_ID,
    subdomain: "softriple-4",
    customDomain: null,
    origin: "https://softriple-4.cleaningcrm.opygen.com",
  });
  tenantPublicUrlMock.buildRootDocumentUrlForAdmin.mockImplementation(
    async (_adminId: string, token: string) =>
      `https://softriple-4.cleaningcrm.opygen.com/${token}`,
  );
});

describe("Phase 2 quote sharing", () => {
  it("activates a DRAFT quote atomically and returns the tenant-root URL without marking it sent", async () => {
    publicationMock.publishQuote.mockResolvedValue({
      id: "quote-1",
      publicToken: TOKEN,
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
      sentAt: null,
      shareUrl: `https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`,
    });
    prismaMock.quote.findFirst.mockResolvedValue({
      id: "quote-1", quoteRef: "#OP-QT-1", status: "SENT", publicToken: TOKEN,
      publishedAt: new Date("2026-09-01T00:00:00.000Z"), sentAt: null,
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      lineItems: [], bookings: [], jobs: [], serviceCatalog: null,
    });

    const result = await quoteService.shareQuote("quote-1", {
      id: "user-1", role: "ADMIN", adminId: "admin-1",
    } as never);

    expect(publicationMock.publishQuote).toHaveBeenCalledWith({
      id: "quote-1", adminId: "admin-1", intent: "PUBLISH",
    });
    expect(result.sentAt).toBeNull();
    expect(result.shareUrl).toBe(`https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`);
  });

  it("fails closed before changing a DRAFT when no public website origin is available", async () => {
    publicationMock.publishQuote.mockRejectedValue(
      new AppError(503, "Public origin unavailable", { code: "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE" }),
    );
    await expect(quoteService.shareQuote("quote-1", {
      id: "user-1", role: "ADMIN", adminId: "admin-1",
    } as never)).rejects.toMatchObject({ code: "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE" });
  });

  it("queues email inside the same publication transaction using the canonical URL", async () => {
    prismaMock.quote.findFirst
      .mockResolvedValueOnce({ id: "quote-1", status: "DRAFT", client: { email: "client@example.com" } })
      .mockResolvedValueOnce({
        id: "quote-1", quoteRef: "#OP-QT-1", status: "SENT", publicToken: TOKEN,
        publishedAt: new Date("2026-09-01T00:00:00.000Z"), sentAt: new Date("2026-09-01T00:00:00.000Z"),
        client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
        lineItems: [], bookings: [], jobs: [], serviceCatalog: null,
      });
    publicationMock.publishQuote.mockImplementation(async (input: { onPublishedTx?: (tx: unknown, value: unknown) => Promise<void> }) => {
      const value = {
        id: "quote-1", publicToken: TOKEN, publishedAt: new Date("2026-09-01T00:00:00.000Z"),
        sentAt: new Date("2026-09-01T00:00:00.000Z"),
        shareUrl: `https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`,
      };
      await input.onPublishedTx?.({ quote: transactionQuoteMock }, value);
      return value;
    });
    queueQuoteSentNotificationMock.mockResolvedValue({ queued: true, deliveryId: "delivery-1" });

    const result = await quoteService.sendQuoteEmail("quote-1", {
      id: "user-1", role: "ADMIN", adminId: "admin-1",
    } as never);

    expect(queueQuoteSentNotificationMock).toHaveBeenCalledWith(
      expect.anything(), "quote-1", "2026-09-01T00:00:00.000Z", result.shareUrl,
    );
  });

  it("binds a public token to the website tenant and returns 404 for the wrong hostname tenant", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ adminId: "wrong-admin" });
    prismaMock.quote.findFirst.mockResolvedValue(null);

    await expect(quoteService.getPublicQuote(TOKEN, WEBSITE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "QUOTE_NOT_FOUND",
    });

    expect(prismaMock.quote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicToken: TOKEN, publishedAt: { not: null }, adminId: "wrong-admin" },
      }),
    );
  });

  it("renders stale SENT quotes as EXPIRED", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ adminId: "admin-1" });
    prismaMock.quote.findFirst.mockResolvedValue(publicQuote("SENT", NOW_PAST()));
    prismaMock.quote.updateMany.mockResolvedValue({ count: 1 });

    const result = await quoteService.getPublicQuote(TOKEN, WEBSITE_ID);

    expect(prismaMock.quote.updateMany).toHaveBeenCalledWith({
      where: { id: "quote-1", status: "SENT" },
      data: { status: "EXPIRED" },
    });
    expect(result.status).toBe("EXPIRED");
  });

  it.each([
    ["accept", "ACCEPTED"],
    ["decline", "DECLINED"],
  ] as const)("keeps the public %s lifecycle working with tenant binding", async (
    action: "accept" | "decline",
    finalStatus: "ACCEPTED" | "DECLINED",
  ) => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ adminId: "admin-1" });
    prismaMock.quote.findFirst
      .mockResolvedValueOnce({
        id: "quote-1",
        quoteRef: "#OP-QT-1",
        adminId: "admin-1",
        status: "SENT",
        validUntil: NOW_FUTURE(),
      })
      .mockResolvedValueOnce(publicQuote(finalStatus));
    prismaMock.quote.updateMany.mockResolvedValue({ count: 1 });
    createNotificationMock.mockResolvedValue(undefined);

    const result = await quoteService.publicQuoteAction(
      TOKEN,
      action,
      action === "decline" ? "Timing changed" : undefined,
      WEBSITE_ID,
    );

    expect(prismaMock.quote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: finalStatus }),
      }),
    );
    expect(result.status).toBe(finalStatus);
  });
});
