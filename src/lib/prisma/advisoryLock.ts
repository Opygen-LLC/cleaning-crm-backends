import type { Prisma } from "../../generated/prisma/client";

/**
 * Prisma's PostgreSQL driver adapter cannot deserialize PostgreSQL's `void`
 * pseudo-type. Project an integer from the locking SELECT instead.
 */
type AdvisoryLockDb = Pick<Prisma.TransactionClient, "$queryRaw">;

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
