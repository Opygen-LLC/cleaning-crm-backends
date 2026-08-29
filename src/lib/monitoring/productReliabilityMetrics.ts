export type ProductReliabilitySignalCode =
  | "ONBOARDING_STEP_RENDER_ERROR"
  | "ONBOARDING_PREVIEW_RENDER_ERROR"
  | "CHUNK_LOAD_ERROR"
  | "BOOTSTRAP_SCHEMA_MISMATCH"
  | "SERVICE_CATALOG_SCHEMA_MISMATCH"
  | "BOOKING_SETUP_SCHEMA_MISMATCH"
  | "ONBOARDING_TRANSACTION_FAILURE"
  | "WEBSITE_PREVIEW_FAILURE"
  | "AUTH_REFRESH_LOOP";

export interface ProductReliabilitySignal {
  at: number;
  code: ProductReliabilitySignalCode;
  releaseVersion: string;
  route: string | null;
  onboardingStep: string | null;
  requestId: string | null;
  traceId: string | null;
}

const WINDOW_MS = Math.min(
  60 * 60_000,
  Math.max(60_000, Number(process.env.PRODUCT_RELIABILITY_WINDOW_MS) || 10 * 60_000),
);
const MAX_SIGNALS = Math.min(10_000, Math.max(100, Number(process.env.PRODUCT_RELIABILITY_MAX_SIGNALS) || 2_000));
const signals: ProductReliabilitySignal[] = [];

const prune = (now = Date.now()): void => {
  const cutoff = now - WINDOW_MS;
  while (signals.length && signals[0]!.at < cutoff) signals.shift();
  if (signals.length > MAX_SIGNALS) signals.splice(0, signals.length - MAX_SIGNALS);
};

export const recordProductReliabilitySignal = (
  input: Omit<ProductReliabilitySignal, "at"> & { at?: number },
): void => {
  signals.push({
    at: input.at ?? Date.now(),
    code: input.code,
    releaseVersion: input.releaseVersion || "unknown",
    route: input.route ?? null,
    onboardingStep: input.onboardingStep ?? null,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
  });
  prune();
};

export const getProductReliabilitySnapshot = () => {
  prune();
  const counts = Object.fromEntries(
    [
      "ONBOARDING_STEP_RENDER_ERROR",
      "ONBOARDING_PREVIEW_RENDER_ERROR",
      "CHUNK_LOAD_ERROR",
      "BOOTSTRAP_SCHEMA_MISMATCH",
      "SERVICE_CATALOG_SCHEMA_MISMATCH",
      "BOOKING_SETUP_SCHEMA_MISMATCH",
      "ONBOARDING_TRANSACTION_FAILURE",
      "WEBSITE_PREVIEW_FAILURE",
      "AUTH_REFRESH_LOOP",
    ].map((code) => [code, 0]),
  ) as Record<ProductReliabilitySignalCode, number>;

  for (const signal of signals) counts[signal.code] += 1;

  return {
    windowMs: WINDOW_MS,
    totalSignals: signals.length,
    counts,
    recent: signals.slice(-50).map((signal) => ({
      ...signal,
      at: new Date(signal.at).toISOString(),
    })),
  };
};

export const resetProductReliabilityMetricsForTests = (): void => {
  signals.splice(0, signals.length);
};

const CONTRACT_SIGNAL_PATTERNS: Array<[RegExp, ProductReliabilitySignalCode]> = [
  [/BOOTSTRAP_SCHEMA_MISMATCH/i, "BOOTSTRAP_SCHEMA_MISMATCH"],
  [/SERVICE(?:_CATALOG)?_SCHEMA_MISMATCH/i, "SERVICE_CATALOG_SCHEMA_MISMATCH"],
  [/WEBSITE_BOOKING_SETUP_SCHEMA_MISMATCH|BOOKING_SETUP_SCHEMA_MISMATCH/i, "BOOKING_SETUP_SCHEMA_MISMATCH"],
];

export const recordClientReliabilitySignals = (input: {
  section: string;
  errorKind?: string | null;
  message: string;
  releaseVersion: string;
  route?: string | null;
  onboardingStep?: string | null;
  requestId?: string | null;
  traceId?: string | null;
}): void => {
  const base = {
    releaseVersion: input.releaseVersion || "unknown",
    route: input.route ?? null,
    onboardingStep: input.onboardingStep ?? null,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
  };
  const record = (code: ProductReliabilitySignalCode) =>
    recordProductReliabilitySignal({ ...base, code });

  if (input.section === "active-step") record("ONBOARDING_STEP_RENDER_ERROR");
  if (input.section === "preview") record("ONBOARDING_PREVIEW_RENDER_ERROR");
  if (input.errorKind === "chunk-load") record("CHUNK_LOAD_ERROR");
  if (input.section === "auth-refresh-loop") record("AUTH_REFRESH_LOOP");

  for (const [pattern, code] of CONTRACT_SIGNAL_PATTERNS) {
    if (pattern.test(input.message)) record(code);
  }
};
