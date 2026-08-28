import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma/prisma";
import {
  invalidateRuntimeAuth,
  invalidateRuntimeSessionValidities,
  invalidateRuntimeSessionValidity,
} from "../../lib/cache/authRuntimeCache";

export interface SessionRequestMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const cleanMetadata = (metadata: SessionRequestMetadata = {}) => ({
  ipAddress: metadata.ipAddress?.trim().slice(0, 128) || null,
  userAgent: metadata.userAgent?.trim().slice(0, 1000) || null,
});

export const hashRefreshCredential = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const createRefreshFamilyId = (): string => randomUUID();

/**
 * Binds the current refresh credential to the Better Auth session and enforces
 * the concurrent-session cap in one PostgreSQL round trip. The refresh token
 * itself is never stored, only its SHA-256 digest.
 */
export async function bindRefreshCredentialToSession(input: {
  userId: string;
  sessionToken: string;
  refreshToken: string;
  refreshFamilyId: string;
  maxSessions: number;
  metadata?: SessionRequestMetadata;
}): Promise<{ bound: boolean; revokedTokens: string[] }> {
  const metadata = cleanMetadata(input.metadata);
  const keepOtherSessions = Math.max(0, input.maxSessions - 1);
  const refreshHash = hashRefreshCredential(input.refreshToken);

  type Row = { bound: number; revokedTokens: string[] | null };
  const rows = await prisma.$queryRaw<Row[]>`
    WITH bound AS (
      UPDATE "session"
      SET "refreshTokenHash" = ${refreshHash},
          "previousRefreshTokenHash" = NULL,
          "refreshFamilyId" = ${input.refreshFamilyId},
          "refreshRotatedAt" = NOW(),
          "lastUsedAt" = NOW(),
          "ipAddress" = COALESCE(${metadata.ipAddress}, "ipAddress"),
          "userAgent" = COALESCE(${metadata.userAgent}, "userAgent"),
          "updatedAt" = NOW()
      WHERE token = ${input.sessionToken}
        AND "userId" = ${input.userId}
        AND "expiresAt" > NOW()
      RETURNING id
    ),
    excess AS (
      SELECT id
      FROM "session"
      WHERE "userId" = ${input.userId}
        AND token <> ${input.sessionToken}
        AND "expiresAt" > NOW()
        AND EXISTS (SELECT 1 FROM bound)
      ORDER BY "createdAt" DESC
      OFFSET ${keepOtherSessions}
    ),
    revoked AS (
      DELETE FROM "session"
      WHERE id IN (SELECT id FROM excess)
      RETURNING token
    )
    SELECT
      (SELECT COUNT(*)::int FROM bound) AS bound,
      COALESCE((SELECT array_agg(token) FROM revoked), ARRAY[]::text[]) AS "revokedTokens"
  `;

  const row = rows[0];
  await invalidateRuntimeSessionValidities(row?.revokedTokens ?? []);
  return { bound: (row?.bound ?? 0) > 0, revokedTokens: row?.revokedTokens ?? [] };
}

export async function revokeSessionByToken(sessionToken: string | null | undefined): Promise<boolean> {
  if (!sessionToken) return false;
  const result = await prisma.session.deleteMany({ where: { token: sessionToken } });
  await invalidateRuntimeSessionValidity(sessionToken);
  return result.count > 0;
}

export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { userId },
    select: { token: true },
  });
  const result = await prisma.session.deleteMany({ where: { userId } });
  await Promise.all([
    invalidateRuntimeSessionValidities(sessions.map((session) => session.token)),
    Promise.resolve(invalidateRuntimeAuth(userId)),
  ]);
  return result.count;
}

export async function revokeOtherSessionsForUser(
  userId: string,
  currentSessionToken: string,
): Promise<{ currentValid: boolean; revokedCount: number; revokedTokens: string[] }> {
  type Row = { currentValid: number; revokedTokens: string[] | null };
  const rows = await prisma.$queryRaw<Row[]>`
    WITH current_session AS (
      SELECT id
      FROM "session"
      WHERE "userId" = ${userId}
        AND token = ${currentSessionToken}
        AND "expiresAt" > NOW()
      LIMIT 1
    ),
    revoked AS (
      DELETE FROM "session"
      WHERE "userId" = ${userId}
        AND token <> ${currentSessionToken}
        AND EXISTS (SELECT 1 FROM current_session)
      RETURNING token
    )
    SELECT
      (SELECT COUNT(*)::int FROM current_session) AS "currentValid",
      COALESCE((SELECT array_agg(token) FROM revoked), ARRAY[]::text[]) AS "revokedTokens"
  `;
  const row = rows[0];
  const revokedTokens = row?.revokedTokens ?? [];
  await invalidateRuntimeSessionValidities(revokedTokens);
  return {
    currentValid: (row?.currentValid ?? 0) > 0,
    revokedCount: revokedTokens.length,
    revokedTokens,
  };
}

export async function revokeSessionByIdForUser(
  userId: string,
  sessionId: string,
  currentSessionToken?: string | null,
): Promise<{ found: boolean; revokedCurrent: boolean }> {
  type Row = { token: string };
  const rows = await prisma.$queryRaw<Row[]>`
    DELETE FROM "session"
    WHERE id = ${sessionId}
      AND "userId" = ${userId}
    RETURNING token
  `;
  const token = rows[0]?.token;
  if (!token) return { found: false, revokedCurrent: false };
  await invalidateRuntimeSessionValidity(token);
  return { found: true, revokedCurrent: Boolean(currentSessionToken && token === currentSessionToken) };
}
