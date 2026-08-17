import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  eval: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));

import { RedisRateLimitStore } from "./redisRateLimitStore";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.del.mockResolvedValue(1);
});

describe("RedisRateLimitStore", () => {
  it("uses the shared Redis counter and does not expose the raw key", async () => {
    redisMock.eval.mockResolvedValue([3, 45_000]);
    const store = new RedisRateLimitStore({ prefix: "public-test", windowMs: 60_000 });

    const result = await store.increment("203.0.113.10");

    expect(result.totalHits).toBe(3);
    const resetTime = result.resetTime;
    expect(resetTime).toBeInstanceOf(Date);
    if (!resetTime) {
      throw new Error("RedisRateLimitStore.increment() did not return resetTime");
    }
    expect(resetTime.getTime()).toBeGreaterThan(Date.now());
    const evalArgs = redisMock.eval.mock.calls[0] ?? [];
    expect(String(evalArgs[2])).not.toContain("203.0.113.10");
  });

  it("falls back to a bounded local counter when Redis is unavailable", async () => {
    redisMock.eval.mockRejectedValue(new Error("redis down"));
    const store = new RedisRateLimitStore({ prefix: "public-test", windowMs: 60_000 });

    const first = await store.increment("visitor");
    const second = await store.increment("visitor");

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });
});
