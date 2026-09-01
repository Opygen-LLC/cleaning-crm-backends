import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

export interface SuperAdminAuditInput {
  actorUserId?: string | null;
  tenantAdminId?: string | null;
  targetUserId?: string | null;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

const sanitizeReason = (reason: string) => reason.trim().slice(0, 500);

export const writeSuperAdminAudit = async (
  input: SuperAdminAuditInput,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  return db.superAdminAuditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      tenantAdminId: input.tenantAdminId ?? null,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      reason: sanitizeReason(input.reason),
      metadata: input.metadata
        ? (JSON.parse(JSON.stringify(input.metadata)) as Prisma.InputJsonValue)
        : undefined,
    },
  });
};
