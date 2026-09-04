import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { getRequestTrace } from "../../lib/monitoring/requestTrace";

export interface SuperAdminAuditInput {
  actorUserId?: string | null;
  tenantAdminId?: string | null;
  targetUserId?: string | null;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const sanitizeReason = (reason: string) => reason.trim().slice(0, 500);
const bounded = (value: string | null | undefined, max: number) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
};
const jsonValue = (value: unknown): Prisma.InputJsonValue | undefined => value === undefined
  ? undefined
  : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * Append-only Super Admin audit writer.
 *
 * Request correlation is picked up from AsyncLocalStorage automatically so
 * service-layer callers cannot accidentally omit requestId. IP/user-agent are
 * explicit because background jobs do not have an HTTP request.
 */
export const writeSuperAdminAudit = async (
  input: SuperAdminAuditInput,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const trace = getRequestTrace();
  return db.superAdminAuditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      tenantAdminId: input.tenantAdminId ?? null,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      reason: sanitizeReason(input.reason),
      metadata: jsonValue(input.metadata),
      before: jsonValue(input.before),
      after: jsonValue(input.after),
      requestId: bounded(input.requestId ?? trace?.requestId, 128),
      ipAddress: bounded(input.ipAddress, 128),
      userAgent: bounded(input.userAgent, 1000),
    },
  });
};
