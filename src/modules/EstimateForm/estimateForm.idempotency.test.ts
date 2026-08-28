import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = { estimateFormSubmission: { findFirst: vi.fn(), create: vi.fn() } };
  return {
    tx,
    formFindFirst: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    lock: vi.fn(),
  };
});

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    estimateForm: { findFirst: mocks.formFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireExtendedTextTransactionAdvisoryLock: mocks.lock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn() }));
vi.mock("../Website/websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: { invalidateAdminWebsite: vi.fn() } }));

import { estimateFormService } from "./estimateForm.service";

const form = {
  id: "form-1", adminId: "admin-1", published: true, showLiveEstimate: true,
  coveredPostcodes: [], coveredCities: [], fields: [], addOns: [],
  admin: { currency: "USD", businessName: "E2E", businessLogo: null, address: null, city: null, zipcode: null, businessEmail: null, mobileNumber: null },
  services: [{
    serviceType: null, serviceCatalogId: "service-1", enabled: true, basePrice: 100,
    serviceCatalog: { id: "service-1", adminId: "admin-1", serviceName: "Deep Clean", basePrice: 100, duration: "120 min", status: "ACTIVE", legacyServiceType: null },
  }],
};

const payload = {
  serviceCatalogId: "service-1", bedrooms: 2, bathrooms: 1, addOnIds: [], postcode: "10001",
  city: "Test City", name: "Jane", email: "jane@example.com", phone: "+15555550123",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formFindFirst.mockResolvedValue(form);
  mocks.tx.estimateFormSubmission.findFirst.mockResolvedValue(null);
  mocks.tx.estimateFormSubmission.create.mockResolvedValue({ id: "submission-1", ref: "#EST-1" });
});

describe("public estimate idempotency", () => {
  it("returns the existing row and never inserts a duplicate", async () => {
    mocks.tx.estimateFormSubmission.findFirst.mockResolvedValue({ id: "existing", ref: "#EST-SAME" });
    const result = await estimateFormService.submitPublicEstimateFormById(
      "form-1", "admin-1", payload as never, "phase7-estimate-key", "website-1",
    );
    expect(result.ref).toBe("#EST-SAME");
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "estimate-idempotency:form-1:phase7-estimate-key");
    expect(mocks.tx.estimateFormSubmission.create).not.toHaveBeenCalled();
  });
});
