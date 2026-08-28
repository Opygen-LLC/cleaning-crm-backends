import { beforeEach, describe, expect, it } from "vitest";
import {
  RedisCircuitOpenError,
  acquireRedisCircuitPermit,
  forceOpenRedisCircuit,
  getRedisCircuitSnapshot,
  recordRedisCircuitFailure,
  recordRedisCircuitSuccess,
  resetRedisCircuitForTests,
} from "./redisCircuitBreaker";

describe("redisCircuitBreaker", () => {
  beforeEach(() => resetRedisCircuitForTests());

  it("opens after repeated availability failures and closes after a successful probe", () => {
    recordRedisCircuitFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));
    recordRedisCircuitFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));
    recordRedisCircuitFailure(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));
    expect(getRedisCircuitSnapshot().state).toBe("open");
    expect(acquireRedisCircuitPermit()).toBe(false);

    expect(acquireRedisCircuitPermit({ forceProbe: true })).toBe(true);
    expect(getRedisCircuitSnapshot().state).toBe("half-open");
    recordRedisCircuitSuccess();
    expect(getRedisCircuitSnapshot().state).toBe("closed");
  });

  it("does not open for application-level Redis errors", () => {
    for (let i = 0; i < 10; i += 1) recordRedisCircuitFailure(new Error("WRONGTYPE"));
    expect(getRedisCircuitSnapshot().state).toBe("closed");
  });

  it("exposes a dedicated fast-fail error", () => {
    forceOpenRedisCircuit();
    const error = new RedisCircuitOpenError(getRedisCircuitSnapshot().retryAfterMs);
    expect(error.code).toBe("REDIS_CIRCUIT_OPEN");
  });
});
