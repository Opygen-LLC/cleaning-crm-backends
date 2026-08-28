import { describe, expect, it } from "vitest";
import {
  getRequestTrace,
  getTracePropagationMetadata,
  recordTraceDatabaseQuery,
  recordTraceRedisCommand,
  recordTraceResponseCache,
  recordTraceSpan,
  runWithRequestTrace,
  traceAsyncOperation,
} from "./requestTrace";

describe("requestTrace", () => {
  it("keeps request/trace correlation across async work and accumulates subsystem timings", async () => {
    await runWithRequestTrace(
      { requestId: "req-123", traceId: "0123456789abcdef0123456789abcdef" },
      async () => {
        await Promise.resolve();
        recordTraceDatabaseQuery(12.5, { operation: "SELECT", table: "user" });
        recordTraceDatabaseQuery(4.5, { operation: "SELECT", table: "session" });
        recordTraceRedisCommand(2.5, { hits: 1 });
        recordTraceResponseCache("miss");
        recordTraceSpan("auth", 3.5, "auth.test");
        await traceAsyncOperation("external", "provider.test", async () => "ok");

        const trace = getRequestTrace();
        expect(trace?.requestId).toBe("req-123");
        expect(trace?.traceId).toBe("0123456789abcdef0123456789abcdef");
        expect(trace?.dbQueryCount).toBe(2);
        expect(trace?.dbDurationMs).toBe(17);
        expect(trace?.slowestDbQuery).toEqual({
          durationMs: 12.5,
          operation: "SELECT",
          table: "user",
        });
        expect(trace?.redisHits).toBe(1);
        expect(trace?.redisMisses).toBe(0);
        expect(trace?.responseCacheMisses).toBe(1);
        expect(trace?.authDurationMs).toBe(3.5);
        expect(trace?.spans["provider.test"]?.count).toBe(1);
        expect(getTracePropagationMetadata()).toEqual({
          requestId: "req-123",
          traceId: "0123456789abcdef0123456789abcdef",
        });
      },
    );
  });

  it("does not leak trace context outside the request scope", () => {
    expect(getRequestTrace()).toBeUndefined();
    expect(getTracePropagationMetadata()).toBeNull();
  });
});
