import { describe, expect, it, vi } from "vitest";

vi.mock("./websiteHostResolver.service", () => ({
  WebsiteHostResolverService: { invalidateSubdomains: vi.fn() },
}));

vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireTextTransactionAdvisoryLock: vi.fn(),
}));

import { buildWebsiteSubdomainBase, reserveWebsiteSubdomainTx } from "./websiteProvisioning.service";

describe("buildWebsiteSubdomainBase", () => {
  it("creates the expected Bio Cleaning registration subdomain", () => {
    expect(buildWebsiteSubdomainBase("Bio Cleaning", "admin-1234567890"))
      .toBe("bio-cleaning");
  });

  it("creates a readable deterministic slug from the business name", () => {
    expect(buildWebsiteSubdomainBase("Sparkle Cleaning London", "admin-1234567890"))
      .toBe("sparkle-cleaning-london");
  });

  it("does not allocate a platform-reserved hostname", () => {
    const value = buildWebsiteSubdomainBase("Admin", "12345678-aaaa-bbbb-cccc-1234567890ab");
    expect(value).not.toBe("admin");
    expect(value.startsWith("admin-")).toBe(true);
  });

  it("uses a stable fallback when the name has no ASCII hostname characters", () => {
    expect(buildWebsiteSubdomainBase(" পরিষ্কার ", "12345678-aaaa-bbbb-cccc-1234567890ab"))
      .toBe("business-12345678aa");
  });

  it("keeps the generated label within DNS limits", () => {
    const value = buildWebsiteSubdomainBase("Very Long Cleaning Company Name ".repeat(8), "admin-1");
    expect(value.length).toBeLessThanOrEqual(63);
  });
});

describe("reserveWebsiteSubdomainTx", () => {
  it("uses deterministic numeric suffixes when Bio Cleaning labels are already occupied", async () => {
    const taken = new Set(["bio-cleaning", "bio-cleaning-2"]);
    const db = {
      businessWebsite: {
        findUnique: vi.fn(async ({ where }: { where: { subdomain: string } }) =>
          taken.has(where.subdomain) ? { id: `website-${where.subdomain}` } : null,
        ),
      },
      websiteSubdomainAlias: {
        findUnique: vi.fn(async () => null),
      },
    };

    const subdomain = await reserveWebsiteSubdomainTx(
      db as never,
      "Bio Cleaning",
      "admin-1234567890",
    );

    expect(subdomain).toBe("bio-cleaning-3");
  });
});
