import { AsyncLocalStorage } from "node:async_hooks";

export type TraceSpanKind = "auth" | "queue" | "external" | "custom";

export interface RequestTraceState {
  requestId: string;
  traceId: string;
  startedAtNs: bigint;
  dbQueryCount: number;
  dbDurationMs: number;
  redisCommandCount: number;
  redisDurationMs: number;
  redisHits: number;
  redisMisses: number;
  redisErrors: number;
  responseCacheHits: number;
  responseCacheMisses: number;
  authDurationMs: number;
  queueDurationMs: number;
  externalDurationMs: number;
  spans: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

const storage = new AsyncLocalStorage<RequestTraceState>();

export const runWithRequestTrace = <T>(
  input: { requestId: string; traceId: string },
  callback: () => T,
): T => storage.run(
  {
    requestId: input.requestId,
    traceId: input.traceId,
    startedAtNs: process.hrtime.bigint(),
    dbQueryCount: 0,
    dbDurationMs: 0,
    redisCommandCount: 0,
    redisDurationMs: 0,
    redisHits: 0,
    redisMisses: 0,
    redisErrors: 0,
    responseCacheHits: 0,
    responseCacheMisses: 0,
    authDurationMs: 0,
    queueDurationMs: 0,
    externalDurationMs: 0,
    spans: {},
  },
  callback,
);

export const getRequestTrace = (): RequestTraceState | undefined => storage.getStore();

export const getTracePropagationMetadata = (): { traceId: string; requestId: string } | null => {
  const trace = storage.getStore();
  return trace ? { traceId: trace.traceId, requestId: trace.requestId } : null;
};

export const recordTraceDatabaseQuery = (durationMs: number): void => {
  const trace = storage.getStore();
  if (!trace) return;
  trace.dbQueryCount += 1;
  trace.dbDurationMs += durationMs;
};

export const recordTraceRedisCommand = (
  durationMs: number,
  input: { hits?: number; misses?: number; error?: boolean } = {},
): void => {
  const trace = storage.getStore();
  if (!trace) return;
  trace.redisCommandCount += 1;
  trace.redisDurationMs += durationMs;
  trace.redisHits += input.hits ?? 0;
  trace.redisMisses += input.misses ?? 0;
  if (input.error) trace.redisErrors += 1;
};

export const recordTraceResponseCache = (outcome: "hit" | "miss"): void => {
  const trace = storage.getStore();
  if (!trace) return;
  if (outcome === "hit") trace.responseCacheHits += 1;
  else trace.responseCacheMisses += 1;
};

export const recordTraceSpan = (
  kind: TraceSpanKind,
  durationMs: number,
  name: string = kind,
): void => {
  const trace = storage.getStore();
  if (!trace) return;
  const safeDuration = Math.max(0, durationMs);
  if (kind === "auth") trace.authDurationMs += safeDuration;
  if (kind === "queue") trace.queueDurationMs += safeDuration;
  if (kind === "external") trace.externalDurationMs += safeDuration;

  const current = trace.spans[name] ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += safeDuration;
  current.maxMs = Math.max(current.maxMs, safeDuration);
  trace.spans[name] = current;
};

export const traceAsyncOperation = async <T>(
  kind: TraceSpanKind,
  name: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const started = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    recordTraceSpan(
      kind,
      Number(process.hrtime.bigint() - started) / 1_000_000,
      name,
    );
  }
};
