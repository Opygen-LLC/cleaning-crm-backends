import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/redis", () => ({
  default: { del: vi.fn(), get: vi.fn(), setex: vi.fn() },
}));
vi.mock("../Website/websiteProjectionCache.service", () => ({
  WebsiteProjectionCacheService: { invalidateAdminWebsite: vi.fn() },
}));
vi.mock("../BookingForm/bookingForm.cache", () => ({
  invalidateBookingFormsForAdmin: vi.fn(),
}));
vi.mock("./serviceCatalog.slug", () => ({
  allocateServiceSlugTx: vi.fn(async () => "generated-slug"),
}));

import { ServiceCategory } from "../../generated/prisma/enums";
import { syncServiceCatalogSelectionTx } from "./serviceCatalog.service";

const makeTx = () => {
  const serviceCatalog = {
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  return { tx: { serviceCatalog } as never, serviceCatalog };
};

const payload = {
  serviceName: "Premium Deep Cleaning",
  description: "Detailed cleaning",
  basePrice: 150,
  duration: "4h",
  category: ServiceCategory.RESIDENTIAL,
  onlineBookingEnabled: true,
};

describe("service catalog onboarding identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames an existing service by stable ServiceCatalog id", async () => {
    const { tx, serviceCatalog } = makeTx();
    serviceCatalog.findMany.mockResolvedValue([
      { id: "service-1", serviceName: "Deep Cleaning", slug: "deep-cleaning" },
    ]);
    serviceCatalog.update.mockResolvedValue({
      id: "service-1",
      serviceName: payload.serviceName,
      slug: "deep-cleaning",
    });

    const result = await syncServiceCatalogSelectionTx(
      tx,
      "admin-1",
      [{ ...payload, serviceCatalogId: "service-1" }],
      { authoritativeSelection: true },
    );

    expect(serviceCatalog.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "service-1" },
      data: expect.objectContaining({ serviceName: "Premium Deep Cleaning" }),
    }));
    expect(serviceCatalog.create).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ id: "service-1" });
  });

  it("rejects an id that does not belong to the tenant", async () => {
    const { tx, serviceCatalog } = makeTx();
    serviceCatalog.findMany.mockResolvedValue([
      { id: "service-1", serviceName: "Deep Cleaning", slug: "deep-cleaning" },
    ]);

    await expect(syncServiceCatalogSelectionTx(
      tx,
      "admin-1",
      [{ ...payload, serviceCatalogId: "foreign-service" }],
      { authoritativeSelection: true },
    )).rejects.toMatchObject({ code: "SERVICE_CATALOG_ID_INVALID", statusCode: 422 });

    expect(serviceCatalog.update).not.toHaveBeenCalled();
    expect(serviceCatalog.create).not.toHaveBeenCalled();
  });

  it("rejects a rename that would collide with another tenant service", async () => {
    const { tx, serviceCatalog } = makeTx();
    serviceCatalog.findMany.mockResolvedValue([
      { id: "service-1", serviceName: "Deep Cleaning", slug: "deep-cleaning" },
      { id: "service-2", serviceName: "Premium Deep Cleaning", slug: "premium-deep-cleaning" },
    ]);

    await expect(syncServiceCatalogSelectionTx(
      tx,
      "admin-1",
      [{ ...payload, serviceCatalogId: "service-1" }],
    )).rejects.toMatchObject({ code: "SERVICE_NAME_CONFLICT", statusCode: 409 });

    expect(serviceCatalog.update).not.toHaveBeenCalled();
  });
});
