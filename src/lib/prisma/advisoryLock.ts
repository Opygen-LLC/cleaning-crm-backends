/**
 * Prisma's PostgreSQL driver adapter cannot deserialize PostgreSQL's `void`
 * pseudo-type. Calling `SELECT pg_advisory_xact_lock(...)` directly therefore
 * fails with P2010 / UnsupportedNativeDataType on newer Prisma driver-adapter
 * builds even though PostgreSQL successfully acquired the lock.
 *
 * Keep the advisory lock as a transaction-scoped database primitive, but only
 * project a normal integer column back to Prisma. The lock function is invoked
 * from the FROM clause, so the result set contains `lockAcquired: 1` instead of
 * a `void` column.
 *
 * Two helpers are kept because the existing codebase intentionally used both
 * hashtext (32-bit) and hashtextextended (64-bit). Preserving those hash
 * functions keeps lock keys compatible during rolling deployments.
 */
export const acquireTextTransactionAdvisoryLock = async (
  db: any,
  key: string,
): Promise<void> => {
  await db.$queryRaw`
    SELECT 1::int AS "lockAcquired"
    FROM pg_advisory_xact_lock(hashtext(${key}))
  `;
};

export const acquireExtendedTextTransactionAdvisoryLock = async (
  db: any,
  key: string,
): Promise<void> => {
  await db.$queryRaw`
    SELECT 1::int AS "lockAcquired"
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))
  `;
};
