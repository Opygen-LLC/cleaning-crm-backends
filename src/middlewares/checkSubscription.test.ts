import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getRuntimeAdminAccessContext: vi.fn(),
  getRuntimeStaffAccessContext: vi.fn(),
  resolver: vi.fn(),
}));

vi.mock("../config/redis", () => ({
  default: { get: vi.fn(async () => null), setex: vi.fn(async () => "OK"), del: vi.fn(async () => 1) },
}));
vi.mock("../lib/prisma/prisma", () => ({
  prisma: { businessWebsite: { findUnique: vi.fn(async () => null) } },
}));
vi.mock("../lib/utils/jwt", () => ({
  jwtUtils: { verifyToken: mocks.verifyToken, createToken: vi.fn(), decodeToken: vi.fn() },
}));
vi.mock("../lib/cache/authRuntimeCache", () => ({
  getRuntimeAdminAccessContext: mocks.getRuntimeAdminAccessContext,
  getRuntimeStaffAccessContext: mocks.getRuntimeStaffAccessContext,
  invalidateRuntimeAdminAccessContext: vi.fn(async () => undefined),
  invalidateRuntimeSubscriptionForAdmin: vi.fn(async () => undefined),
}));
vi.mock("../modules/Entitlement/tenantAccessResolver.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/Entitlement/tenantAccessResolver.service")>();
  return {
    ...actual,
    TenantAccessResolver: {
      resolve: mocks.resolver,
      invalidate: vi.fn(async () => undefined),
      featureAllowed: vi.fn(),
    },
  };
});

import { checkFeature, checkSubscription } from "./checkSubscription";

const ADMIN_USER_ID = "user-admin-1";
const STAFF_USER_ID = "user-staff-1";
const ORGANIZATION_ID = "admin-profile-1";

function makeReq(opts: { bearer?: string; cookie?: string } = {}): Request {
  return {
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    cookies: opts.cookie ? { accessToken: opts.cookie } : {},
  } as unknown as Request;
}
function makeRes(): Response { return {} as Response; }
function makeNext() { return vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>; }
function verifiesAs(role: "ADMIN" | "STAFF" | "SUPER_ADMIN", userId: string) {
  mocks.verifyToken.mockReturnValue({ success: true, data: { userId, role } });
}

function access(overrides: {
  deniedReason?: string;
  dashboardAllowed?: boolean;
  effectiveEntitlements?: Record<string, boolean>;
} = {}) {
  const deniedReason = overrides.deniedReason ?? "ACTIVE";
  const dashboardAllowed = overrides.dashboardAllowed ?? deniedReason === "ACTIVE";
  return {
    organizationId: ORGANIZATION_ID,
    ownerUserId: ADMIN_USER_ID,
    platform: { status: "ACTIVE", suspendedAt: null, archivedAt: null, reason: null },
    subscription: {
      id: "sub-1", status: "ACTIVE", isTrial: false, trialEndsAt: null,
      currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    },
    website: { status: "PUBLISHED", published: true, publicAccessAllowed: dashboardAllowed, deniedReason },
    access: {
      dashboardAllowed,
      publicWebsiteAllowed: dashboardAllowed,
      publicWritesAllowed: dashboardAllowed,
      backgroundJobsAllowed: dashboardAllowed,
      recoveryAllowed: true,
      deniedReason,
    },
    plan: { id: "plan-family", name: "GROWTH", pricingId: "price-row", features: [] },
    baseEntitlements: {},
    paidExtras: { staff: 0, clients: 0, monthlyBookings: 0, storageMb: 0 },
    tenantOverrides: { active: false, expiresAt: null, reason: null, features: {}, resources: {} },
    effectiveEntitlements: {
      website: true,
      online_booking: true,
      coupons: false,
      auto_dispatch: false,
      recurring_bookings: false,
      ...(overrides.effectiveEntitlements ?? {}),
    },
    resourceLimits: { base: {}, afterPaidExtras: {}, effective: {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeAdminAccessContext.mockResolvedValue({ role: "ADMIN", userStatus: "ACTIVE", adminId: ORGANIZATION_ID });
  mocks.getRuntimeStaffAccessContext.mockResolvedValue({ role: "STAFF", userStatus: "ACTIVE", adminId: ORGANIZATION_ID });
  mocks.resolver.mockResolvedValue(access());
});

describe("checkSubscription canonical organization gate", () => {
  it("passes through when no access token is present", async () => {
    const next = makeNext();
    await checkSubscription(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it("passes through when token verification fails", async () => {
    mocks.verifyToken.mockReturnValue({ success: false });
    const next = makeNext();
    await checkSubscription(makeReq({ bearer: "bad" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolver).not.toHaveBeenCalled();
  });

  it("keeps SUPER_ADMIN outside tenant subscription gating", async () => {
    verifiesAs("SUPER_ADMIN", "sa-1");
    const next = makeNext();
    await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolver).not.toHaveBeenCalled();
  });

  it("resolves ADMIN access using canonical AdminProfile.id and exposes the decision on the request", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    const req = makeReq({ bearer: "t" });
    const next = makeNext();
    await checkSubscription(req, makeRes(), next);
    expect(mocks.getRuntimeAdminAccessContext).toHaveBeenCalledWith(ADMIN_USER_ID);
    expect(mocks.resolver).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(req.authRuntime).toMatchObject({ adminId: ORGANIZATION_ID, accessDeniedReason: "ACTIVE" });
    expect(next).toHaveBeenCalledWith();
  });

  it("also applies the organization access decision to STAFF", async () => {
    verifiesAs("STAFF", STAFF_USER_ID);
    const next = makeNext();
    await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);
    expect(mocks.getRuntimeStaffAccessContext).toHaveBeenCalledWith(STAFF_USER_ID);
    expect(mocks.resolver).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(next).toHaveBeenCalledWith();
  });

  it("blocks STAFF when the owning organization is suspended", async () => {
    verifiesAs("STAFF", STAFF_USER_ID);
    mocks.resolver.mockResolvedValue(access({ deniedReason: "TENANT_SUSPENDED", dashboardAllowed: false }));
    const next = makeNext();
    await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("fails closed when an authenticated tenant user has no canonical organization", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    mocks.getRuntimeAdminAccessContext.mockResolvedValue({ role: "ADMIN", userStatus: "ACTIVE", adminId: null });
    const next = makeNext();
    await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(mocks.resolver).not.toHaveBeenCalled();
  });

  for (const [reason, code] of [
    ["TENANT_SUSPENDED", 403], ["TENANT_ARCHIVED", 403], ["OWNER_ACCOUNT_SUSPENDED", 403],
    ["SUBSCRIPTION_SUSPENDED", 402], ["PAYMENT_PENDING", 402], ["TRIAL_EXPIRED", 402],
    ["SUBSCRIPTION_EXPIRED", 402], ["SUBSCRIPTION_MISSING", 402],
  ] as const) {
    it(`blocks ${reason} with ${code}`, async () => {
      verifiesAs("ADMIN", ADMIN_USER_ID);
      mocks.resolver.mockResolvedValue(access({ deniedReason: reason, dashboardAllowed: false }));
      const next = makeNext();
      await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: code }));
    });
  }
});

describe("checkFeature stable-key gate", () => {
  it("accepts a canonical key when effective entitlement is enabled", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    mocks.resolver.mockResolvedValue(access({ effectiveEntitlements: { coupons: true } }));
    const next = makeNext();
    await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts a legacy label only as a compatibility alias", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    mocks.resolver.mockResolvedValue(access({ effectiveEntitlements: { auto_dispatch: true } }));
    const next = makeNext();
    await checkFeature("Auto-Dispatch!!")(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("blocks when the canonical effective entitlement is disabled", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    const next = makeNext();
    await checkFeature("recurring_bookings")(makeReq({ bearer: "t" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("reuses effective entitlements already attached by checkSubscription", async () => {
    verifiesAs("ADMIN", ADMIN_USER_ID);
    const req = makeReq({ bearer: "t" });
    req.authRuntime = {
      userStatus: "ACTIVE", adminId: ORGANIZATION_ID, subscriptionPlanName: "GROWTH",
      subscriptionFeatures: [], entitlementSummary: [], effectiveEntitlements: { coupons: true }, accessDeniedReason: "ACTIVE",
    };
    const next = makeNext();
    await checkFeature("coupons")(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolver).not.toHaveBeenCalled();
  });

  it("throws during route construction for an unknown feature key", () => {
    expect(() => checkFeature("definitely_unknown_capability")).toThrow(/Unknown feature gate/);
  });
});
