/**
 * Provisioning touches several tenant-owned tables and also takes PostgreSQL
 * advisory locks. Keep the transaction long enough for normal production
 * latency, but bounded so a stalled database connection cannot pin a worker
 * indefinitely during signup/backfill.
 */
export const PROVISIONING_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 20_000,
} as const;
