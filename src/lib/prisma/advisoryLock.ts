/**
 * Minimal structural contract required by the advisory-lock helpers.
 *
 * Prisma's `$queryRaw` returns a `PrismaPromise`, while unit-test doubles
 * normally return a native `Promise`. Requiring the complete Prisma method
 * type made otherwise valid test doubles fail TypeScript assignability solely
 * because their `Symbol.toStringTag` differs. `PromiseLike<unknown>` is the
 * correct boundary here: these helpers only await the query and never depend
 * on PrismaPromise-specific behaviour.
 */
export interface AdvisoryLockDb {
  $queryRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<unknown>;
}

/**
 * Prisma's PostgreSQL driver adapter cannot deserialize PostgreSQL's `void`
 * pseudo-type. Project an integer from the locking SELECT instead.
 */
export const acquireTextTransactionAdvisoryLock = async (
  db: AdvisoryLockDb,
  key: string,
): Promise<void> => {
  await db.$queryRaw`
    SELECT 1::int AS "lockAcquired"
    FROM pg_advisory_xact_lock(hashtext(${key}))
  `;
};

export const acquireExtendedTextTransactionAdvisoryLock = async (
  db: AdvisoryLockDb,
  key: string,
): Promise<void> => {
  await db.$queryRaw`
    SELECT 1::int AS "lockAcquired"
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))
  `;
};
