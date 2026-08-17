import type { Prisma } from "../../generated/prisma/client";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";

/**
 * Allocate the globally unique human-readable lead reference inside the
 * caller's transaction. The PostgreSQL advisory lock serializes every lead
 * producer (admin UI, website acquisition, future imports) across API replicas.
 */
export const allocateLeadRef = async (tx: Prisma.TransactionClient): Promise<string> => {
  await acquireExtendedTextTransactionAdvisoryLock(tx, "lead-ref-sequence");

  const rows = await tx.$queryRaw<Array<{ maxNumber: string }>>`
    SELECT COALESCE(MAX((regexp_match("leadRef", '([0-9]+)$'))[1]::bigint), 0)::text AS "maxNumber"
    FROM "lead"
    WHERE "leadRef" ~ '[0-9]+$'
  `;

  const lastNumber = Number.parseInt(rows[0]?.maxNumber ?? "0", 10);
  const nextNumber = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
  return `LEAD-${String(nextNumber).padStart(4, "0")}`;
};
