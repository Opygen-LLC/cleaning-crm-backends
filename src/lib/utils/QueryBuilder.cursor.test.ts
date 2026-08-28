import { describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "./QueryBuilder";

const cursor = (createdAt: string, id: string) =>
  Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");

describe("QueryBuilder cursor pagination", () => {
  it("uses deterministic createdAt/id keyset pagination without deep OFFSET", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "c3", createdAt: new Date("2026-08-27T10:00:00.000Z") },
      { id: "c2", createdAt: new Date("2026-08-27T09:00:00.000Z") },
      { id: "c1", createdAt: new Date("2026-08-27T08:00:00.000Z") },
    ]);
    const count = vi.fn().mockResolvedValue(100_000);

    const result = await new QueryBuilder(
      { findMany, count },
      { limit: "2", cursor: cursor("2026-08-27T11:00:00.000Z", "c4") },
    )
      .where({ adminId: "admin-1" })
      .paginate()
      .sort()
      .execute();

    const args = findMany.mock.calls[0]?.[0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(3);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.where).toEqual(expect.objectContaining({ AND: expect.any(Array) }));
    expect(result.data).toHaveLength(2);
    expect(result.meta).toMatchObject({ paginationMode: "cursor", hasMore: true, total: 100_000 });
    expect(result.meta.nextCursor).toEqual(expect.any(String));
  });

  it("keeps legacy offset pagination backward compatible", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);

    const result = await new QueryBuilder({ findMany, count }, { page: "3", limit: "25" })
      .paginate()
      .sort()
      .execute();

    expect(findMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ skip: 50, take: 25 }));
    expect(result.meta).toMatchObject({ page: 3, limit: 25, paginationMode: "offset" });
  });

  it("rejects malformed cursors as a client error", () => {
    const builder = new QueryBuilder({ findMany: vi.fn(), count: vi.fn() }, { cursor: "not-a-cursor" });
    expect(() => builder.paginate()).toThrow("Invalid pagination cursor");
  });
});
