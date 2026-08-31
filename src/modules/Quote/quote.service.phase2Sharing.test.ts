import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  transactionQuoteMock,
  getAdminIdMock,
  createNotificationMock,
  queueQuoteSentNotificationMock,
  tenantPublicUrlMock,
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
  queueQuoteSentNotification: queueQuoteSentNotificationMock,
}));
vi.mock("../Website/tenantPublicUrl.service", () => ({
  TenantPublicUrlService: tenantPublicUrlMock,
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
  it("activates a DRAFT quote atomically and returns the tenant-root URL", async () => {
    transactionQuoteMock.findFirst.mockResolvedValue({
      id: "quote-1",
      status: "DRAFT",
      publicToken: null,
      sentAt: null,
      validUntil: NOW_FUTURE(),
    });
    transactionQuoteMock.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: "quote-1",
      quoteRef: "#OP-QT-1",
      status: data.status,
      publicToken: data.publicToken,
      sentAt: data.sentAt,
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      lineItems: [],
      bookings: [],
      jobs: [],
    }));

    const result = await quoteService.shareQuote("quote-1", {
      id: "user-1",
      role: "ADMIN",
      adminId: "admin-1",
    } as never);

    expect(tenantPublicUrlMock.resolveForAdminId).toHaveBeenCalledWith("admin-1");
    expect(transactionQuoteMock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote-1", adminId: "admin-1" } }),
    );
    expect(transactionQuoteMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT", sentAt: expect.any(Date) }),
      }),
    );
    expect(result.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.shareUrl).toBe(
      `https://softriple-4.cleaningcrm.opygen.com/${result.publicToken}`,
    );
    expect(result.shareUrl).not.toContain("//A");
  });

  it("fails closed before changing a DRAFT when no public website origin is available", async () => {
    tenantPublicUrlMock.resolveForAdminId.mockRejectedValue(
      new AppError(503, "Public origin unavailable", {
        code: "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE",
      }),
    );

    await expect(
      quoteService.shareQuote("quote-1", {
        id: "user-1",
        role: "ADMIN",
        adminId: "admin-1",
      } as never),
    ).rejects.toMatchObject({ code: "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });


  it("passes the exact activated canonical share URL into the email outbox", async () => {
    prismaMock.quote.findFirst.mockResolvedValue({
      id: "quote-1",
      status: "DRAFT",
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      admin: { businessName: "Softriple Cleaning", businessEmail: "hello@example.com", currency: "USD" },
      lineItems: [],
      serviceCatalog: null,
    });
    transactionQuoteMock.findFirst.mockResolvedValue({
      id: "quote-1",
      status: "DRAFT",
      publicToken: TOKEN,
      sentAt: null,
      validUntil: NOW_FUTURE(),
    });
    transactionQuoteMock.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: "quote-1",
      quoteRef: "#OP-QT-1",
      status: data.status,
      publicToken: TOKEN,
      sentAt: data.sentAt,
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      lineItems: [],
      bookings: [],
      jobs: [],
    }));
    queueQuoteSentNotificationMock.mockResolvedValue({ queued: true, deliveryId: "delivery-1" });

    const result = await quoteService.sendQuoteEmail("quote-1", {
      id: "user-1",
      role: "ADMIN",
      adminId: "admin-1",
    } as never);

    expect(result.shareUrl).toBe(`https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`);
    expect(queueQuoteSentNotificationMock).toHaveBeenCalledWith(
      "quote-1",
      expect.any(String),
      result.shareUrl,
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
        where: { publicToken: TOKEN, adminId: "wrong-admin" },
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
