import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

interface Options {
  mode: "public" | "dashboard";
  url: string;
  users: number;
  requests: number;
  tokenFile?: string;
}

const arg = (name: string) => process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))?.split("=", 2)[1];
const positive = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const options: Options = {
  mode: arg("mode") === "dashboard" ? "dashboard" : "public",
  url: arg("url") ?? process.env.PHASE10_LOAD_URL ?? "",
  users: positive(arg("users"), 500, 1000),
  requests: positive(arg("requests"), 5000, 100_000),
  tokenFile: arg("token-file") ?? process.env.PHASE10_TOKEN_FILE,
};

if (!options.url) throw new Error("Pass --url=https://... or PHASE10_LOAD_URL");

const loadTokens = async (): Promise<string[]> => {
  if (options.mode !== "dashboard") return [];
  if (!options.tokenFile) throw new Error("Dashboard load test requires --token-file with one bearer token per line");
  const raw = await readFile(options.tokenFile, "utf8");
  const tokens = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("Token file is empty");
  const distinctTokens = [...new Set(tokens)];
  if (distinctTokens.length < options.users) {
    throw new Error(`Dashboard ${options.users}-account load test requires at least ${options.users} distinct bearer tokens; received ${distinctTokens.length}`);
  }
  return distinctTokens;
};

const percentile = (values: number[], pct: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1))]!;
};

const run = async () => {
  const tokens = await loadTokens();
  const latencies: number[] = [];
  let failures = 0;
  let cursor = 0;
  const started = performance.now();

  const worker = async (workerIndex: number) => {
    for (;;) {
      const index = cursor++;
      if (index >= options.requests) return;
      const requestStarted = performance.now();
      try {
        const token = tokens.length ? tokens[(index + workerIndex) % tokens.length] : null;
        const response = await fetch(options.url, {
          method: "GET",
          headers: {
            Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) failures += 1;
        await response.arrayBuffer();
      } catch {
        failures += 1;
      } finally {
        latencies.push(performance.now() - requestStarted);
      }
    }
  };

  await Promise.all(Array.from({ length: options.users }, (_, index) => worker(index)));
  const elapsedMs = performance.now() - started;
  const success = options.requests - failures;
  const summary = {
    mode: options.mode,
    url: options.url,
    virtualUsers: options.users,
    requests: options.requests,
    success,
    failures,
    errorRate: Number((failures / options.requests).toFixed(4)),
    requestsPerSecond: Number((options.requests / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
      max: Number(latencies.reduce((current, value) => Math.max(current, value), 0).toFixed(2)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errorRate > 0.01) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
