import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { redisMock, redisStore, redisSets } = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  const redisSets = new Map<string, Set<string>>();
  return {
    redisStore,
    redisSets,
    redisMock: {
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        redisStore.set(key, value);
        return "OK";
      }),
      incr: vi.fn(async (key: string) => {
        const next = Number(redisStore.get(key) ?? "0") + 1;
        redisStore.set(key, String(next));
        return next;
      }),
      sadd: vi.fn(async (key: string, value: string) => {
        const set = redisSets.get(key) ?? new Set<string>();
        const before = set.size;
        set.add(value);
        redisSets.set(key, set);
        return set.size > before ? 1 : 0;
      }),
      expire: vi.fn().mockResolvedValue(1),
      sscan: vi.fn(async (key: string) => ["0", Array.from(redisSets.get(key) ?? [])]),
      unlink: vi.fn(async (...keys: string[]) => {
        let removed = 0;
        for (const key of keys) if (redisStore.delete(key)) removed += 1;
        return removed;
      }),
      del: vi.fn(async (key: string) => {
        const existed = redisSets.delete(key) || redisStore.delete(key);
        return existed ? 1 : 0;
      }),
    },
  };
});

vi.mock("../config/redis", () => ({ default: redisMock }));

import { privateResponseCache } from "./privateResponseCache";
import { bumpCacheResourceVersions, CacheResource } from "../lib/cache/resourceCacheVersion";

function makeRequest(method = "GET") {
  return {
    method,
    originalUrl: "/api/v1/dashboard/overview?period=30d",
    headers: {},
    user: { id: "user-1", adminId: "tenant-1", role: "ADMIN", email: "admin@example.com" },
  } as unknown as Request;
}

function makeResponse() {
  const headers = new Map<string, string>();
  const result = { body: "", ended: false };
  const response = {
    statusCode: 200,
    setHeader(this: any, name: string, value: string) { headers.set(name.toLowerCase(), String(value)); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    type(this: any, value: string) { this.setHeader("Content-Type", value); return this; },
    status(this: any, value: number) { this.statusCode = value; return this; },
    send(this: any, body: unknown) { result.body = String(body); return this; },
    end(this: any) { result.ended = true; return this; },
  } as unknown as Response;
  return { response, result, headers };
}

async function flushAsyncCacheWrites() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("privateResponseCache resource generations", () => {
  beforeEach(() => {
    redisStore.clear();
    redisSets.clear();
    vi.clearAllMocks();
  });

  it("serves the second GET from the same tenant/resource generation", async () => {
    const first = makeResponse();
    const payload = JSON.stringify({ success: true, data: { revenue: 123 } });
    const firstNext: NextFunction = vi.fn(() => {
      first.response.setHeader("Content-Type", "application/json; charset=utf-8");
      first.response.send(payload);
    });

    await privateResponseCache(makeRequest(), first.response, firstNext);
    await flushAsyncCacheWrites();
    expect(firstNext).toHaveBeenCalledOnce();
    expect(redisMock.setex).toHaveBeenCalledOnce();
    expect(redisMock.sadd).toHaveBeenCalledOnce();

    const second = makeResponse();
    const secondNext: NextFunction = vi.fn();
    await privateResponseCache(makeRequest(), second.response, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(second.result.body).toBe(payload);
    expect(second.headers.get("x-response-cache")).toBe("HIT-REDIS");
  });

  it("makes the next GET miss immediately after an awaited resource bump", async () => {
    const first = makeResponse();
    const firstNext: NextFunction = vi.fn(() => {
      first.response.setHeader("Content-Type", "application/json");
      first.response.send(JSON.stringify({ success: true, data: { count: 1 } }));
    });
    await privateResponseCache(makeRequest(), first.response, firstNext);
    await flushAsyncCacheWrites();

    await bumpCacheResourceVersions("tenant-1", [CacheResource.dashboard]);

    const second = makeResponse();
    const secondNext: NextFunction = vi.fn(() => {
      second.response.setHeader("Content-Type", "application/json");
      second.response.send(JSON.stringify({ success: true, data: { count: 2 } }));
    });
    await privateResponseCache(makeRequest(), second.response, secondNext);

    expect(redisMock.incr).toHaveBeenCalledWith("tenant:tenant-1:dashboard:version");
    expect(secondNext).toHaveBeenCalledOnce();
    expect(second.headers.get("x-response-cache")).toBe("MISS");
  });

  it("does not cache non-JSON responses", async () => {
    const output = makeResponse();
    const next: NextFunction = vi.fn(() => {
      output.response.setHeader("Content-Type", "application/pdf");
      output.response.send("binary");
    });
    await privateResponseCache(makeRequest(), output.response, next);
    await flushAsyncCacheWrites();
    expect(redisMock.setex).not.toHaveBeenCalled();
    expect(redisMock.sadd).not.toHaveBeenCalled();
  });
});
