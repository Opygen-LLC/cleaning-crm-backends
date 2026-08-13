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
      sadd: vi.fn(async (key: string, value: string) => {
        const set = redisSets.get(key) ?? new Set<string>();
        const before = set.size;
        set.add(value);
        redisSets.set(key, set);
        return set.size > before ? 1 : 0;
      }),
      expire: vi.fn().mockResolvedValue(1),
      sscan: vi.fn(async (key: string) => [
        "0",
        Array.from(redisSets.get(key) ?? []),
      ]),
      unlink: vi.fn(async (...keys: string[]) => {
        let removed = 0;
        for (const key of keys) {
          if (redisStore.delete(key)) removed += 1;
        }
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

import {
  invalidatePrivateResponseCache,
  privateResponseCache,
} from "./privateResponseCache";

function makeRequest(method = "GET") {
  return {
    method,
    originalUrl: "/api/v1/dashboard/overview?period=30d",
    headers: {},
    user: {
      id: "user-1",
      adminId: "tenant-1",
      role: "ADMIN",
      email: "admin@example.com",
    },
  } as unknown as Request;
}

function makeResponse() {
  const headers = new Map<string, string>();
  const result = { body: "", ended: false };
  const response = {
    statusCode: 200,
    setHeader(this: any, name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    type(this: any, value: string) {
      this.setHeader("Content-Type", value);
      return this;
    },
    status(this: any, value: number) {
      this.statusCode = value;
      return this;
    },
    send(this: any, body: unknown) {
      result.body = String(body);
      return this;
    },
    end(this: any) {
      result.ended = true;
      return this;
    },
    once: vi.fn(),
  } as unknown as Response;
  return { response, result, headers };
}

async function flushAsyncCacheWrites() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("privateResponseCache", () => {
  beforeEach(() => {
    redisStore.clear();
    redisSets.clear();
    vi.clearAllMocks();
  });

  it("serves the second tenant-scoped GET from Redis without controller work", async () => {
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
    expect(redisStore.size).toBe(1);

    redisMock.get.mockClear();
    const second = makeResponse();
    const secondNext: NextFunction = vi.fn();
    const started = performance.now();
    await privateResponseCache(makeRequest(), second.response, secondNext);
    const duration = performance.now() - started;

    expect(secondNext).not.toHaveBeenCalled();
    expect(redisMock.get).toHaveBeenCalledOnce();
    expect(second.result.body).toBe(payload);
    expect(second.headers.get("x-response-cache")).toBe("HIT-REDIS");
    expect(duration).toBeLessThan(50);
  });

  it("invalidates via the tenant index instead of scanning the Redis keyspace", async () => {
    const output = makeResponse();
    const next: NextFunction = vi.fn(() => {
      output.response.setHeader("Content-Type", "application/json");
      output.response.send(JSON.stringify({ success: true }));
    });

    await privateResponseCache(makeRequest(), output.response, next);
    await flushAsyncCacheWrites();
    expect(redisStore.size).toBe(1);

    invalidatePrivateResponseCache("tenant-1");
    await flushAsyncCacheWrites();

    expect(redisMock.sscan).toHaveBeenCalled();
    expect(redisMock.unlink).toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
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
    expect(redisStore.size).toBe(0);
  });
});
