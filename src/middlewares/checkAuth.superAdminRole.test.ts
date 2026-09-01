import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRole } from "../generated/prisma/enums";

const mocks = vi.hoisted(() => ({
  getVerifiedAccessToken: vi.fn(),
  getRuntimeUserStatus: vi.fn(),
  rateLimit: vi.fn(),
  privateCache: vi.fn(),
}));

vi.mock("../lib/utils/cookie", () => ({ CookieUtils: { getCookie: vi.fn(() => "access-token") } }));
vi.mock("../lib/utils/verifiedRequestToken", () => ({ getVerifiedAccessToken: mocks.getVerifiedAccessToken }));
vi.mock("../lib/cache/authRuntimeCache", () => ({
  getRuntimeAdminAccessContext: vi.fn(),
  getRuntimeSessionValidity: vi.fn(),
  getRuntimeStaffAccessContext: vi.fn(),
  getRuntimeTenantId: vi.fn(),
  getRuntimeTenantLifecycleStatus: vi.fn(),
  getRuntimeTenantOwnerStatus: vi.fn(),
  getRuntimeUserStatus: mocks.getRuntimeUserStatus,
}));
vi.mock("./privateResponseCache", () => ({ privateResponseCache: mocks.privateCache }));
vi.mock("./privateApiRateLimit", () => ({ enforcePrivateApiRateLimit: mocks.rateLimit }));
vi.mock("../lib/monitoring/requestTrace", () => ({ recordTraceSpan: vi.fn() }));

import { checkAuth } from "./checkAuth";

const invoke = async (role: UserRole) => {
  mocks.getVerifiedAccessToken.mockReturnValue({
    success: true,
    data: { userId: `${role.toLowerCase()}-1`, email: `${role.toLowerCase()}@example.com`, role },
  });
  mocks.getRuntimeUserStatus.mockResolvedValue("ACTIVE");
  const req = { headers: {}, cookies: {}, authRuntime: undefined } as never;
  const res = {} as never;
  const next = vi.fn();
  await checkAuth(UserRole.SUPER_ADMIN)(req, res, next);
  return next;
};

describe("SUPER_ADMIN authorization boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([UserRole.ADMIN, UserRole.STAFF])("rejects %s before tenant service execution", async (role) => {
    const next = await invoke(role);
    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0];
    expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(mocks.privateCache).not.toHaveBeenCalled();
  });

  it("allows a healthy SUPER_ADMIN through the role boundary", async () => {
    mocks.privateCache.mockImplementation(async (_req, _res, next) => next());
    const next = await invoke(UserRole.SUPER_ADMIN);
    expect(mocks.getRuntimeUserStatus).toHaveBeenCalledWith("super_admin-1");
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls.some((call) => call[0] instanceof Error)).toBe(false);
  });
});
