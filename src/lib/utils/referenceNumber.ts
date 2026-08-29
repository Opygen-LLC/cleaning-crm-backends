import type { Prisma } from "../../generated/prisma/client";
import { acquireExtendedTextTransactionAdvisoryLock } from "../prisma/advisoryLock";

export type ReferenceKind =
  | "booking"
  | "job"
  | "invoice"
  | "quote"
  | "estimate"
  | "payment"
  | "recurring";

const PREFIX: Record<ReferenceKind, string> = {
  booking: "#OP-BK-",
  job: "#OP-JB-",
  invoice: "#OP-INV-",
  quote: "#OP-QT-",
  estimate: "#OP-EST-",
  payment: "#OP-PAY-",
  recurring: "#RS-",
};

type MaxRow = { maxNumber: bigint | number | string | null };

/**
 * Allocate a monotonically increasing human-readable reference while holding a
 * PostgreSQL transaction advisory lock for the whole read+create transaction.
 *
 * IMPORTANT: Call this with the `tx` received inside prisma.$transaction and
 * create the corresponding row before that transaction returns. Calling it on
 * the root Prisma client would release the lock before the insert and would
 * re-introduce the race this helper is designed to remove.
 *
 * References remain globally unique because the existing database schema uses
 * global unique indexes. A global sequence also avoids cross-tenant collisions
 * without a breaking schema/index migration.
 */
export const nextReference = async (
  tx: Prisma.TransactionClient,
  kind: ReferenceKind,
): Promise<string> => {
  await acquireExtendedTextTransactionAdvisoryLock(tx, `reference:${kind}`);

  let rows: MaxRow[];
  switch (kind) {
    case "booking":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "bookingRef" ~ '^#OP-BK-[0-9]+$'
            THEN regexp_replace("bookingRef", '^#OP-BK-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "booking"
      `) as MaxRow[];
      break;
    case "job":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "jobRef" ~ '^#OP-JB-[0-9]+$'
            THEN regexp_replace("jobRef", '^#OP-JB-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "job"
      `) as MaxRow[];
      break;
    case "invoice":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "invoiceRef" ~ '^#OP-INV-[0-9]+$'
            THEN regexp_replace("invoiceRef", '^#OP-INV-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "invoice"
      `) as MaxRow[];
      break;
    case "quote":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "quoteRef" ~ '^#OP-QT-[0-9]+$'
            THEN regexp_replace("quoteRef", '^#OP-QT-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "quote"
      `) as MaxRow[];
      break;
    case "estimate":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "estimateRef" ~ '^#OP-EST-[0-9]+$'
            THEN regexp_replace("estimateRef", '^#OP-EST-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "estimate"
      `) as MaxRow[];
      break;
    case "payment":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "paymentRef" ~ '^#OP-PAY-[0-9]+$'
            THEN regexp_replace("paymentRef", '^#OP-PAY-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "payment"
      `) as MaxRow[];
      break;
    case "recurring":
      rows = (await tx.$queryRaw`
        SELECT MAX(
          CASE WHEN "scheduleRef" ~ '^#RS-[0-9]+$'
            THEN regexp_replace("scheduleRef", '^#RS-', '')::bigint
          END
        ) AS "maxNumber"
        FROM "recurring_schedule"
      `) as MaxRow[];
      break;
  }

  const max = rows[0]?.maxNumber == null ? 0 : Number(rows[0].maxNumber);
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new Error(`Invalid ${kind} reference sequence state`);
  }

  return `${PREFIX[kind]}${String(max + 1).padStart(4, "0")}`;
};
