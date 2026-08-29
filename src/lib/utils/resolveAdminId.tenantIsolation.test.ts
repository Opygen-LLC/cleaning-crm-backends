import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRole } from "../../generated/prisma/enums";
import type { IRequestUser } from "../../types/requestUser.interface";

const mocks = vi.hoisted(() => ({ getRuntimeTenantId: vi.fn() }));
vi.mock("../cache/authRuntimeCache", () => ({ getRuntimeTenantId: mocks.getRuntimeTenantId }));

import { getAdminId } from "./resolveAdminId";

const user = (id: string, role: UserRole, adminId?: string): IRequestUser => ({
  id,
  email: `${id}@example.com`,
  role,
  adminId,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeTenantId.mockImplementation(async (id: string) => ({
    "admin-a-user": "admin-a",
    "admin-b-user": "admin-b",
    "staff-a-user": "admin-a",
    "staff-b-user": "admin-b",
  } as Record<string, string | undefined>)[id]);
});

describe("tenant isolation resolver contract", () => {
  it.each([
    ["Admin A", user("admin-a-user", UserRole.ADMIN, "admin-a"), "admin-a"],
    ["Admin B", user("admin-b-user", UserRole.ADMIN, "admin-b"), "admin-b"],
    ["Staff A", user("staff-a-user", UserRole.STAFF, "admin-a"), "admin-a"],
    ["Staff B", user("staff-b-user", UserRole.STAFF, "admin-b"), "admin-b"],
  ])("keeps %s on its owning tenant", async (_label, requestUser, expectedAdminId) => {
    await expect(getAdminId(requestUser)).resolves.toBe(expectedAdminId);
    expect(mocks.getRuntimeTenantId).not.toHaveBeenCalled();
  });

  it("resolves a non-request fallback using the real user id and role", async () => {
    await expect(getAdminId(user("staff-a-user", UserRole.STAFF))).resolves.toBe("admin-a");
    expect(mocks.getRuntimeTenantId).toHaveBeenCalledWith("staff-a-user", UserRole.STAFF);
  });

  it("does not allow a tenantless Super Admin into tenant-scoped services", async () => {
    const action = getAdminId(user("super-user", UserRole.SUPER_ADMIN));
    await expect(action).rejects.toMatchObject({
      statusCode: 500,
      code: "TENANT_CONTEXT_RESOLUTION_FAILED",
      kind: "TENANT_INVARIANT",
    });
  });
});
