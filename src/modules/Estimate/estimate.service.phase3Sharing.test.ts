import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  txEstimateMock,
  getAdminIdMock,
  publicDocumentLinkMock,
  queueEstimateSentNotificationMock,
  createNotificationMock,
} = vi.hoisted(() => {
  const txEstimateMock = { findFirst: vi.fn(), update: vi.fn() };
  return {
    txEstimateMock,
    prismaMock: {
      estimate: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ estimate: txEstimateMock }),
      ),
    },
    getAdminIdMock: vi.fn(),
    publicDocumentLinkMock: {
      isValidToken: vi.fn((value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)),
      resolveWebsiteAdminId: vi.fn(),
      resolveForAdmin: vi.fn(),
      generateUniqueToken: vi.fn(),
      buildFromResolution: vi.fn(),
      buildPublicDocumentUrl: vi.fn(),
    },
    queueEstimateSentNotificationMock: vi.fn(),
    createNotificationMock: vi.fn(),
  };
});

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("../../generated/prisma/enums", () => ({
  EstimateStatus: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    CONVERTED: "CONVERTED",
  },
  NotificationType: { GENERAL: "GENERAL" },
}));
vi.mock("../../lib/utils/QueryBuilder", () => ({ QueryBuilder: class QueryBuilder {} }));
vi.mock("../../lib/utils/checkPlanLimits", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireExtendedTextTransactionAdvisoryLock: vi.fn() }));
vi.mock("../../lib/validation/phone", () => ({ requireE164Phone: vi.fn() }));
vi.mock("../Quote/quote.service", () => ({ quoteInclude: {} }));
vi.mock("../../lib/utils/referenceNumber", () => ({ nextReference: vi.fn() }));
vi.mock("../../lib/utils/serviceIdentity", () => ({
  inferLegacyServiceType: vi.fn(),
  resolveFlexibleServiceIdentity: vi.fn(),
}));
vi.mock("../Website/publicDocumentLink.service", () => ({ PublicDocumentLinkService: publicDocumentLinkMock }));
vi.mock("../../lib/notifications/businessNotificationEvents", () => ({
  queueEstimateSentNotification: queueEstimateSentNotificationMock,
}));
vi.mock("../../lib/utils/createNotification", () => ({ createNotification: createNotificationMock }));

import { estimateService } from "./estimate.service";

const TOKEN = "E".repeat(43);
const WEBSITE_ID = "11111111-1111-4111-8111-111111111111";
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

const publicEstimate = (status = "SENT", validUntil = future()) => ({
  estimateRef: "#OP-EST-1",
  status,
  serviceType: null,
  serviceNameSnapshot: "Deep clean",
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
  lineItems: [{ description: "Deep clean", quantity: 1, unitPrice: 100, total: 100 }],
  serviceCatalog: { serviceName: "Deep clean" },
  client: { name: "Client" },
  admin: {
    businessName: "Softriple Cleaning",
    businessEmail: "hello@example.com",
    businessLogo: null,
    brandColor: "#111111",
    mobileNumber: "+15555550100",
    currency: "USD",
    businessWebsite: {
      primaryColor: "#111111",
      secondaryColor: "#ffffff",
      accentColor: "#16A34A",
      logo: null,
      subdomain: "softriple-4",
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  publicDocumentLinkMock.resolveForAdmin.mockResolvedValue({
    websiteId: WEBSITE_ID,
    subdomain: "softriple-4",
    origin: "https://softriple-4.cleaningcrm.opygen.com",
  });
  publicDocumentLinkMock.generateUniqueToken.mockResolvedValue(TOKEN);
  publicDocumentLinkMock.buildFromResolution.mockImplementation(
    (resolution: { origin: string }, input: { token: string }) => `${resolution.origin}/${input.token}`,
  );
  publicDocumentLinkMock.buildPublicDocumentUrl.mockResolvedValue(
    `https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`,
  );
  publicDocumentLinkMock.resolveWebsiteAdminId.mockResolvedValue("admin-1");
});

describe("Phase 3 estimate public sharing", () => {
  it("activates a DRAFT estimate and returns the backend-owned tenant URL", async () => {
    txEstimateMock.findFirst.mockResolvedValue({
      id: "estimate-1",
      status: "DRAFT",
      publicToken: null,
      sentAt: null,
      validUntil: future(),
    });
    txEstimateMock.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: "estimate-1",
      estimateRef: "#OP-EST-1",
      status: data.status,
      publicToken: data.publicToken,
      sentAt: data.sentAt,
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      lineItems: [],
      jobs: [],
      serviceCatalog: null,
    }));

    const result = await estimateService.shareEstimate("estimate-1", {
      id: "user-1",
      role: "ADMIN",
      adminId: "admin-1",
    } as never);

    expect(publicDocumentLinkMock.resolveForAdmin).toHaveBeenCalledWith("admin-1");
    expect(txEstimateMock.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicToken: TOKEN, status: "SENT", sentAt: expect.any(Date) }),
    }));
    expect(result.shareUrl).toBe(`https://softriple-4.cleaningcrm.opygen.com/${TOKEN}`);
  });

  it("passes the exact activated canonical URL to the estimate email outbox", async () => {
    prismaMock.estimate.findFirst.mockResolvedValue({
      id: "estimate-1",
      status: "DRAFT",
      client: { email: "client@example.com" },
    });
    txEstimateMock.findFirst.mockResolvedValue({
      id: "estimate-1",
      status: "DRAFT",
      publicToken: TOKEN,
      sentAt: null,
      validUntil: future(),
    });
    txEstimateMock.update.mockReturnValue({
      id: "estimate-1",
      estimateRef: "#OP-EST-1",
      status: "SENT",
      publicToken: TOKEN,
      sentAt: new Date("2026-09-01T00:00:00.000Z"),
      client: { id: "client-1", name: "Client", email: "client@example.com", phone: "+15555550100" },
      lineItems: [],
      jobs: [],
      serviceCatalog: null,
    });
    queueEstimateSentNotificationMock.mockResolvedValue({ queued: true });

    const result = await estimateService.sendEstimateEmail("estimate-1", {
      id: "user-1",
      role: "ADMIN",
      adminId: "admin-1",
    } as never);

    expect(queueEstimateSentNotificationMock).toHaveBeenCalledWith(
      "estimate-1",
      "2026-09-01T00:00:00.000Z",
      result.shareUrl,
    );
  });

  it("binds the token to website ownership and returns 404 for the wrong tenant", async () => {
    publicDocumentLinkMock.resolveWebsiteAdminId.mockResolvedValue("wrong-admin");
    prismaMock.estimate.findFirst.mockResolvedValue(null);

    await expect(estimateService.getPublicEstimate(TOKEN, WEBSITE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "ESTIMATE_NOT_FOUND",
    });
    expect(prismaMock.estimate.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { publicToken: TOKEN, adminId: "wrong-admin" },
    }));
  });

  it("marks stale SENT estimates as expired in the public DTO without exposing a predictable credential", async () => {
    prismaMock.estimate.findFirst.mockResolvedValue(publicEstimate("SENT", past()));
    const result = await estimateService.getPublicEstimate(TOKEN, WEBSITE_ID);
    expect(result.isExpired).toBe(true);
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("clientId");
    expect(result).not.toHaveProperty("internalNotes");
  });

  it("atomically approves a tenant-bound SENT estimate", async () => {
    prismaMock.estimate.findFirst
      .mockResolvedValueOnce({
        id: "estimate-1",
        estimateRef: "#OP-EST-1",
        adminId: "admin-1",
        status: "SENT",
        validUntil: future(),
      })
      .mockResolvedValueOnce(publicEstimate("APPROVED"));
    prismaMock.estimate.updateMany.mockResolvedValue({ count: 1 });

    const result = await estimateService.publicEstimateAction(TOKEN, "approve", undefined, WEBSITE_ID);

    expect(prismaMock.estimate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "estimate-1", status: "SENT" }),
      data: expect.objectContaining({ status: "APPROVED", respondedAt: expect.any(Date) }),
    }));
    expect(result.status).toBe("APPROVED");
    expect(createNotificationMock).toHaveBeenCalled();
  });
});
