import { describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "./boundedTtlCache";

describe("BoundedTtlCache", () => {
  it("returns warm values without asynchronous work", () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 10 });
    cache.set("dashboard", "cached", 1_000);
    expect(cache.get("dashboard")).toBe("cached");
  });

  it("expires entries at their TTL", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<string>({ maxEntries: 10 });
    cache.set("dashboard", "cached", 50);
    vi.advanceTimersByTime(51);
    expect(cache.get("dashboard")).toBeUndefined();
    vi.useRealTimers();
  });

  it("evicts the least recently used entry", () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 2 });
    cache.set("one", "1", 1_000);
    cache.set("two", "2", 1_000);
    expect(cache.get("one")).toBe("1");
    cache.set("three", "3", 1_000);
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("one")).toBe("1");
  });

  it("enforces the configured memory ceiling", () => {
    const cache = new BoundedTtlCache<string>({
      maxEntries: 10,
      maxBytes: 5,
    });
    cache.set("one", "1234", 1_000, 4);
    cache.set("two", "5678", 1_000, 4);
    expect(cache.get("one")).toBeUndefined();
    expect(cache.get("two")).toBe("5678");
  });

  it("invalidates a complete tenant namespace by prefix", () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 10 });
    cache.set("tenant-a:user-1:route", "a", 1_000);
    cache.set("tenant-a:user-2:route", "b", 1_000);
    cache.set("tenant-b:user-3:route", "c", 1_000);
    cache.deleteByPrefix("tenant-a:");
    expect(cache.get("tenant-a:user-1:route")).toBeUndefined();
    expect(cache.get("tenant-a:user-2:route")).toBeUndefined();
    expect(cache.get("tenant-b:user-3:route")).toBe("c");
  });
});
