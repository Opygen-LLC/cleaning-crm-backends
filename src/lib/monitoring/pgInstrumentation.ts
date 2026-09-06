import type { Pool, PoolClient } from "pg";
import { errorMonitor } from "node:events";
import { getRequestTrace, recordTraceDatabasePoolWait, recordTraceDatabaseQuery, type RequestTraceState } from "./requestTrace";

export interface DatabaseObservation { durationMs: number; query: string; error: boolean; trace?: RequestTraceState }
export function summarizeSql(query: string) {
  const normalized = query.replace(/\s+/g, " ").trim();
  return {
    operation: normalized.match(/^(SELECT|INSERT|UPDATE|DELETE|WITH|BEGIN|COMMIT|ROLLBACK|SET)/i)?.[1]?.toUpperCase() ?? "QUERY",
    table: normalized.match(/(?:FROM|INTO|UPDATE|JOIN)\s+(?:"public"\.)?"([^";]+)"/i)?.[1] ?? "database",
  };
}
const installed = new WeakSet<object>();
const clients = new WeakSet<object>();
/** Instrument at the pg boundary (Prisma 7 driver adapter), not a guessed
 * Prisma URL pool. Preserve pg's callback / Promise overloads and release.
 * No query parameters, raw driver errors or connection strings are captured.
 */
export function instrumentPgPool(pool: Pool, observe: (event: DatabaseObservation) => void): void {
  if (installed.has(pool)) return;
  installed.add(pool);
  const instrumentClient = (client: PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query;
    client.query = function(this: PoolClient, ...originalArgs: unknown[]) {
      const trace = getRequestTrace();
      const started = process.hrtime.bigint();
      const input = originalArgs[0];
      const text = typeof input === "string" ? input : input && typeof input === "object" && "text" in input ? String(input.text) : "";
      let done = false;
      const finish = (error: boolean) => {
        if (done) return; done = true;
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        // An instrumentation failure must never alter transaction semantics.
        try { recordTraceDatabaseQuery(durationMs, summarizeSql(text), trace); observe({ durationMs, query: text, error, trace }); } catch { /* telemetry only */ }
      };
      const args = [...originalArgs];
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        args[args.length - 1] = function(this: unknown, ...values: unknown[]) { finish(Boolean(values[0])); return callback.apply(this, values); };
      }
      try {
        // The cast is confined to pg's overloaded I/O boundary. Callers retain
        // PoolClient.query's real typed overloads.
        const result = (query as (...args: unknown[]) => unknown).apply(this, args);
        if (typeof callback === "function") return result;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(value => { finish(false); return value; }, error => { finish(true); throw error; });
        }
        // Query/Submittable (stream/cursor) callers keep the exact return value.
        const emitter = result as { once?: (event: string | symbol, handler: () => void) => unknown } | undefined;
        if (emitter?.once) { emitter.once("end", () => finish(false)); emitter.once(errorMonitor, () => finish(true)); }
        return result;
      } catch (error) { finish(true); throw error; }
    } as PoolClient["query"];
  };
  const connect = pool.connect;
  pool.connect = function(this: Pool, callback?: (error: Error, client: PoolClient, release: (error?: Error | boolean) => void) => void) {
    const trace = getRequestTrace();
    const started = process.hrtime.bigint();
    let recorded = false;
    const finish = (error: boolean) => {
      if (recorded) return; recorded = true;
      try { recordTraceDatabasePoolWait(Number(process.hrtime.bigint() - started) / 1_000_000, error, trace); } catch { /* telemetry only */ }
    };
    if (callback) {
      try {
        return connect.call(this, (error, client, release) => {
          finish(Boolean(error));
          if (!error && client) instrumentClient(client);
          callback(error, client, release);
        });
      } catch (error) { finish(true); throw error; }
    }
    try {
      return (connect as () => Promise<PoolClient>).call(this).then(client => { finish(false); instrumentClient(client); return client; }, error => { finish(true); throw error; });
    } catch (error) { finish(true); throw error; }
  } as Pool["connect"];
}
