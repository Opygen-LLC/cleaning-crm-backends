import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestTraceState {
  requestId: string;
  startedAtNs: bigint;
  dbQueryCount: number;
  dbDurationMs: number;
  redisCommandCount: number;
  redisDurationMs: number;
}

const storage = new AsyncLocalStorage<RequestTraceState>();

export const runWithRequestTrace = <T>(requestId: string, callback: () => T): T =>
  storage.run(
    {
      requestId,
      startedAtNs: process.hrtime.bigint(),
      dbQueryCount: 0,
      dbDurationMs: 0,
      redisCommandCount: 0,
      redisDurationMs: 0,
    },
    callback,
  );

export const getRequestTrace = (): RequestTraceState | undefined => storage.getStore();

export const recordTraceDatabaseQuery = (durationMs: number): void => {
  const trace = storage.getStore();
  if (!trace) return;
  trace.dbQueryCount += 1;
  trace.dbDurationMs += durationMs;
};

export const recordTraceRedisCommand = (durationMs: number): void => {
  const trace = storage.getStore();
  if (!trace) return;
  trace.redisCommandCount += 1;
  trace.redisDurationMs += durationMs;
};
