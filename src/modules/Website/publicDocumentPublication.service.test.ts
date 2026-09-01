import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, linkMock } = vi.hoisted(() => {
  const tx = {
    quote: { findFirst: vi.fn(), update: vi.fn() },
    estimate: { findFirst: vi.fn(), update: vi.fn() },
  };
  return {
    prismaMock: {
      $transaction: vi.fn(async (callback: (txArg: typeof tx) => unknown) => callback(tx)),
      __tx: tx,
    },
    linkMock: {
      resolveForAdmin: vi.fn(),
      generateUniqueToken: vi.fn(),
      buildFromResolution: vi.fn(),
    },
  };
});

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("./publicDocumentLink.service", () => ({
  PublicDocumentLinkService: linkMock,
}));
vi.mock("../../generated/prisma/enums", () => ({
  QuoteStatus: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    ACCEPTED: "ACCEPTED",
    DECLINED: "DECLINED",
    EXPIRED: "EXPIRED",
  },
  EstimateStatus: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    CONVERTED: "CONVERTED",
  },
}));

import { PublicDocumentPublicationService } from "./publicDocumentPublication.service";

const TOKEN = "P".repeat(43);
const RESOLUTION = {
  websiteId: "11111111-1111-4111-8111-111111111111",
  subdomain: "tenant-a",
  origin: "https://tenant-a.cleaningcrm.opygen.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  linkMock.resolveForAdmin.mockResolvedValue(RESOLUTION);
  linkMock.generateUniqueToken.mockResolvedValue(TOKEN);
  linkMock.buildFromResolution.mockImplementation(
    (resolution: { origin: string }, input: { token: string }) => `${resolution.origin}/${input.token}`,
  );
});

describe("PublicDocumentPublicationService", () => {
  it("keeps DRAFT creation private without resolving a website or allocating a token", async () => {
    await expect(PublicDocumentPublicationService.prepareCreation({
      adminId: "admin-a",
      resourceType: "quote",
      deliveryIntent: "DRAFT",
    })).resolves.toEqual({
      status: "DRAFT",
      publicToken: null,
      publishedAt: null,
      sentAt: null,
      shareUrl: null,
    });

    expect(linkMock.resolveForAdmin).not.toHaveBeenCalled();
    expect(linkMock.generateUniqueToken).not.toHaveBeenCalled();
  });

  it("prepares PUBLISH with a canonical public URL but no email timestamp", async () => {
    const publication = await PublicDocumentPublicationService.prepareCreation({
      adminId: "admin-a",
      resourceType: "quote",
      deliveryIntent: "PUBLISH",
    });

    expect(publication.status).toBe("SENT");
    expect(publication.publicToken).toBe(TOKEN);
    expect(publication.publishedAt).toBeInstanceOf(Date);
    expect(publication.sentAt).toBeNull();
    expect(publication.shareUrl).toBe(`${RESOLUTION.origin}/${TOKEN}`);
  });

  it("prepares SEND with publication and email timestamps from the same operation", async () => {
    const publication = await PublicDocumentPublicationService.prepareCreation({
      adminId: "admin-a",
      resourceType: "estimate",
      deliveryIntent: "SEND",
    });

    expect(publication.status).toBe("SENT");
    expect(publication.publicToken).toBe(TOKEN);
    expect(publication.publishedAt).toBeInstanceOf(Date);
    expect(publication.sentAt).toEqual(publication.publishedAt);
    expect(publication.shareUrl).toBe(`${RESOLUTION.origin}/${TOKEN}`);
  });

  it("publishes a draft quote atomically and invokes the transaction hook with the live URL", async () => {
    const tx = prismaMock.__tx;
    tx.quote.findFirst.mockResolvedValue({
      id: "quote-1",
      status: "DRAFT",
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      publicToken: null,
      publishedAt: null,
      sentAt: null,
    });
    tx.quote.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "quote-1",
      publicToken: data.publicToken as string,
      publishedAt: data.publishedAt as Date,
      sentAt: null,
    }));
    const onPublishedTx = vi.fn().mockResolvedValue(undefined);

    const result = await PublicDocumentPublicationService.publishQuote({
      id: "quote-1",
      adminId: "admin-a",
      intent: "PUBLISH",
      onPublishedTx,
    });

    expect(tx.quote.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "quote-1" },
      data: expect.objectContaining({
        publicToken: TOKEN,
        status: "SENT",
        publishedAt: expect.any(Date),
      }),
    }));
    expect(tx.quote.update.mock.calls[0]?.[0]?.data).not.toHaveProperty("sentAt");
    expect(result).toMatchObject({
      id: "quote-1",
      publicToken: TOKEN,
      sentAt: null,
      shareUrl: `${RESOLUTION.origin}/${TOKEN}`,
    });
    expect(onPublishedTx).toHaveBeenCalledWith(tx, result);
  });

  it("sends an estimate by stamping sentAt and invoking the outbox hook inside the transaction", async () => {
    const tx = prismaMock.__tx;
    tx.estimate.findFirst.mockResolvedValue({
      id: "estimate-1",
      status: "DRAFT",
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      publicToken: null,
      publishedAt: null,
      sentAt: null,
    });
    tx.estimate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "estimate-1",
      publicToken: data.publicToken as string,
      publishedAt: data.publishedAt as Date,
      sentAt: data.sentAt as Date,
    }));
    const onPublishedTx = vi.fn().mockResolvedValue(undefined);

    const result = await PublicDocumentPublicationService.publishEstimate({
      id: "estimate-1",
      adminId: "admin-a",
      intent: "SEND",
      onPublishedTx,
    });

    expect(tx.estimate.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        publicToken: TOKEN,
        status: "SENT",
        publishedAt: expect.any(Date),
        sentAt: expect.any(Date),
      }),
    }));
    expect(result.sentAt).toBeInstanceOf(Date);
    expect(onPublishedTx).toHaveBeenCalledWith(tx, result);
  });

  it("fails closed before opening a transaction if the tenant has no canonical public website", async () => {
    linkMock.resolveForAdmin.mockRejectedValue(new Error("website not configured"));

    await expect(PublicDocumentPublicationService.publishQuote({
      id: "quote-1",
      adminId: "admin-a",
      intent: "PUBLISH",
    })).rejects.toThrow("website not configured");

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("keeps terminal published documents resolvable but refuses to send them again", async () => {
    const tx = prismaMock.__tx;
    const publishedAt = new Date("2026-09-01T00:00:00.000Z");
    tx.quote.findFirst.mockResolvedValue({
      id: "quote-1",
      status: "ACCEPTED",
      validUntil: new Date("2026-09-30T00:00:00.000Z"),
      publicToken: TOKEN,
      publishedAt,
      sentAt: null,
    });

    await expect(PublicDocumentPublicationService.publishQuote({
      id: "quote-1",
      adminId: "admin-a",
      intent: "PUBLISH",
    })).resolves.toMatchObject({ id: "quote-1", publicToken: TOKEN, publishedAt });
    expect(tx.quote.update).not.toHaveBeenCalled();

    await expect(PublicDocumentPublicationService.publishQuote({
      id: "quote-1",
      adminId: "admin-a",
      intent: "SEND",
    })).rejects.toMatchObject({ code: "QUOTE_NOT_SENDABLE" });
  });
});
