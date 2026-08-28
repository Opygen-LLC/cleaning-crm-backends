import {
  REDIS_CIRCUIT_FAILURE_THRESHOLD,
  REDIS_CIRCUIT_OPEN_MS,
} from "../../config/ENV";

export class RedisCircuitOpenError extends Error {
  readonly code = "REDIS_CIRCUIT_OPEN";

  constructor(public readonly retryAfterMs: number) {
    super("Redis circuit is temporarily open; bypassing cache until the next probe.");
    this.name = "RedisCircuitOpenError";
  }
}

type CircuitState = "closed" | "open" | "half-open";

interface RedisCircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: string | null;
  retryAfterMs: number;
  failureThreshold: number;
  openMs: number;
}

let state: CircuitState = "closed";
let consecutiveFailures = 0;
let openedAtMs = 0;
let probeInFlight = false;

const now = () => Date.now();

const open = () => {
  state = "open";
  openedAtMs = now();
  probeInFlight = false;
};

const close = () => {
  state = "closed";
  consecutiveFailures = 0;
  openedAtMs = 0;
  probeInFlight = false;
};

export const isRedisAvailabilityError = (error: unknown): boolean => {
  if (error instanceof RedisCircuitOpenError) return true;
  const value = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const name = typeof value?.name === "string" ? value.name.toUpperCase() : "";
  const message = typeof value?.message === "string" ? value.message.toUpperCase() : "";

  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "NR_CLOSED",
  ].includes(code) ||
    name.includes("MAXRETRIESPERREQUEST") ||
    message.includes("COMMAND TIMED OUT") ||
    message.includes("CONNECTION IS CLOSED") ||
    message.includes("CONNECTION IS NOT WRITABLE") ||
    message.includes("REDIS CONNECTION");
};

/**
 * Returns true for the one command allowed to probe Redis after the cooldown.
 * All other cache commands fail immediately while the circuit is open.
 */
export const acquireRedisCircuitPermit = (options: { forceProbe?: boolean } = {}): boolean => {
  if (state === "closed") return true;

  const elapsed = now() - openedAtMs;
  const cooldownElapsed = elapsed >= REDIS_CIRCUIT_OPEN_MS;
  if (!cooldownElapsed && !options.forceProbe) return false;

  if (probeInFlight) return false;
  state = "half-open";
  probeInFlight = true;
  return true;
};

export const recordRedisCircuitSuccess = (): void => {
  close();
};

export const recordRedisCircuitFailure = (error: unknown, options: { immediate?: boolean } = {}): void => {
  if (!options.immediate && !isRedisAvailabilityError(error)) {
    // Application-level Redis errors (WRONGTYPE, bad arguments, etc.) are bugs,
    // not infrastructure outages, so they must not disable the cache globally.
    if (state === "half-open") probeInFlight = false;
    return;
  }

  consecutiveFailures += 1;
  probeInFlight = false;
  if (options.immediate || state === "half-open" || consecutiveFailures >= REDIS_CIRCUIT_FAILURE_THRESHOLD) {
    open();
  }
};

export const forceOpenRedisCircuit = (): void => {
  consecutiveFailures = Math.max(consecutiveFailures, REDIS_CIRCUIT_FAILURE_THRESHOLD);
  open();
};

export const forceCloseRedisCircuit = (): void => {
  close();
};

export const getRedisCircuitSnapshot = (): RedisCircuitSnapshot => {
  const elapsed = openedAtMs ? now() - openedAtMs : 0;
  return {
    state,
    consecutiveFailures,
    openedAt: openedAtMs ? new Date(openedAtMs).toISOString() : null,
    retryAfterMs: state === "closed" ? 0 : Math.max(0, REDIS_CIRCUIT_OPEN_MS - elapsed),
    failureThreshold: REDIS_CIRCUIT_FAILURE_THRESHOLD,
    openMs: REDIS_CIRCUIT_OPEN_MS,
  };
};

export const resetRedisCircuitForTests = (): void => close();
