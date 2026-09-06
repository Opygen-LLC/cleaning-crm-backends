import { monitorEventLoopDelay, performance } from "node:perf_hooks";

// Native histogram, one per process. No interval, database request or socket.
// Its memory is bounded; observe the existing API process, not a diagnostic CLI.
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const startedAt = new Date().toISOString();
let previous = performance.eventLoopUtilization();
export function getRuntimePerformanceSnapshot() {
  const current = performance.eventLoopUtilization();
  const interval = performance.eventLoopUtilization(current, previous); previous = current;
  const ms = (value: number) => Number.isFinite(value) ? Math.round(value / 1e6 * 100) / 100 : null;
  return { clock: "node-process", startedAt, uptimeSeconds: Math.round(process.uptime()),
    eventLoop: { sampledSinceProcessStart: true, resolutionMs: 20, p50Ms: ms(histogram.percentile(50)), p95Ms: ms(histogram.percentile(95)),
      p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max), utilizationSinceLastRead: interval.utilization },
    memory: process.memoryUsage() };
}
