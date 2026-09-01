import type { Prisma } from "../../generated/prisma/client";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";

const MAX_SLUG_BASE_LENGTH = 72;

export const toServiceSlugBase = (serviceName: string): string => {
  const normalized = serviceName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/g, "");
  return normalized || "service";
};

/**
 * Allocate one stable tenant-scoped public service slug. The transaction-level
 * advisory lock makes two concurrent service creates for the same tenant
 * serialize before the unique index is reached.
 */
export const allocateServiceSlugTx = async (
  tx: Prisma.TransactionClient,
  adminId: string,
  serviceName: string,
): Promise<string> => {
  await acquireExtendedTextTransactionAdvisoryLock(tx, `service-catalog-slug:${adminId}`);
  const base = toServiceSlugBase(serviceName);
  const existing = await tx.serviceCatalog.findMany({
    where: { adminId, slug: { startsWith: base } },
    select: { slug: true },
    take: 500,
  });
  const used = new Set(existing.map((item) => item.slug));
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }

  // This is practically unreachable, but keeping the allocator bounded makes
  // the failure mode explicit rather than looping forever on corrupt data.
  throw new Error("Unable to allocate a unique public service slug");
};
