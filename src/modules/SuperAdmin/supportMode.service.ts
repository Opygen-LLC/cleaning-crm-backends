import { randomUUID } from "node:crypto";
import type { Request } from "express";
import status from "http-status";
import { SignOptions } from "jsonwebtoken";
import redis from "../../config/redis";
import { ACCESS_TOKEN_SECRET } from "../../config/ENV";
import AppError from "../../errorHelper/AppError";
import { AccountStatus, TenantLifecycleStatus, UserRole } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { CookieUtils } from "../../lib/utils/cookie";
import { jwtUtils } from "../../lib/utils/jwt";
import { writeSuperAdminAudit } from "./superAdminAudit.service";

export const SUPPORT_MODE_COOKIE = "support_mode";
const SUPPORT_SESSION_PREFIX = "super-admin:support-mode:session:";
const SUPPORT_ACTOR_PREFIX = "super-admin:support-mode:actor:";
const MIN_REASON = 10;
const ALLOWED_DURATIONS = new Set([15, 30]);

type PersistedSupportSession = {
  id: string;
  supportAdminId: string;
  organizationId: string;
  targetUserId: string;
  targetName: string;
  targetEmail: string;
  businessName: string;
  reason: string;
  readOnly: true;
  startedAt: string;
  expiresAt: string;
};

export type ActiveSupportMode = PersistedSupportSession & {
  targetRole: UserRole.ADMIN;
};

type SupportTokenPayload = {
  typ: "support_mode";
  sessionId: string;
  supportAdminId: string;
  organizationId: string;
  targetUserId: string;
};

const normalizedReason = (value: string) => {
  const reason = String(value ?? "").trim();
  if (reason.length < MIN_REASON) throw new AppError(status.BAD_REQUEST, `reason must be at least ${MIN_REASON} characters.`);
  return reason.slice(0, 500);
};

const durationSeconds = (minutes?: number) => {
  const value = Number(minutes ?? 15);
  if (!ALLOWED_DURATIONS.has(value)) throw new AppError(status.BAD_REQUEST, "Support mode duration must be 15 or 30 minutes.");
  return value * 60;
};

const sessionKey = (id: string) => `${SUPPORT_SESSION_PREFIX}${id}`;
const actorKey = (id: string) => `${SUPPORT_ACTOR_PREFIX}${id}`;

const redisUnavailable = () => new AppError(status.SERVICE_UNAVAILABLE, "Read-only support mode is temporarily unavailable because its coordination store is unavailable.", {
  code: "SUPPORT_MODE_UNAVAILABLE",
  retryable: true,
});

const parseToken = (token: string): SupportTokenPayload => {
  const verified = jwtUtils.verifyToken(token, ACCESS_TOKEN_SECRET);
  if (!verified.success || !verified.data) throw new AppError(status.UNAUTHORIZED, "Support mode has expired or is invalid.", { code: "SUPPORT_MODE_INVALID", retryable: false });
  const payload = verified.data as unknown as SupportTokenPayload;
  if (payload.typ !== "support_mode" || !payload.sessionId || !payload.supportAdminId || !payload.organizationId || !payload.targetUserId) {
    throw new AppError(status.UNAUTHORIZED, "Support mode token is invalid.", { code: "SUPPORT_MODE_INVALID", retryable: false });
  }
  return payload;
};

const getPersisted = async (sessionId: string): Promise<PersistedSupportSession> => {
  let raw: string | null;
  try { raw = await redis.get(sessionKey(sessionId)); }
  catch { throw redisUnavailable(); }
  if (!raw) throw new AppError(status.UNAUTHORIZED, "Support mode is no longer active.", { code: "SUPPORT_MODE_ENDED", retryable: false });
  try { return JSON.parse(raw) as PersistedSupportSession; }
  catch { throw new AppError(status.UNAUTHORIZED, "Support mode state is invalid.", { code: "SUPPORT_MODE_INVALID", retryable: false }); }
};

const assertTargetStillAvailable = async (session: PersistedSupportSession) => {
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: session.organizationId },
    select: {
      id: true,
      businessName: true,
      lifecycleStatus: true,
      user: { select: { id: true, name: true, email: true, emailVerified: true, role: true, status: true } },
    },
  });
  if (!tenant || tenant.user.id !== session.targetUserId || tenant.user.role !== UserRole.ADMIN) {
    throw new AppError(status.UNAUTHORIZED, "Support mode target is no longer available.", { code: "SUPPORT_MODE_TARGET_UNAVAILABLE", retryable: false });
  }
  if (tenant.lifecycleStatus !== TenantLifecycleStatus.ACTIVE || tenant.user.status !== AccountStatus.ACTIVE || !tenant.user.emailVerified) {
    throw new AppError(status.UNAUTHORIZED, "Support mode target is no longer active and verified.", { code: "SUPPORT_MODE_TARGET_UNAVAILABLE", retryable: false });
  }
  return tenant;
};

export const startSupportMode = async (input: {
  supportAdminId: string;
  organizationId: string;
  reason: string;
  durationMinutes?: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}) => {
  const reason = normalizedReason(input.reason);
  const ttl = durationSeconds(input.durationMinutes);
  const actor = await prisma.user.findUnique({ where: { id: input.supportAdminId }, select: { id: true, role: true, status: true } });
  if (!actor || actor.role !== UserRole.SUPER_ADMIN || actor.status !== AccountStatus.ACTIVE) {
    throw new AppError(status.FORBIDDEN, "Only an active Super Admin can start support mode.");
  }
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: input.organizationId },
    select: {
      id: true,
      businessName: true,
      lifecycleStatus: true,
      user: { select: { id: true, name: true, email: true, emailVerified: true, role: true, status: true } },
    },
  });
  if (!tenant) throw new AppError(status.NOT_FOUND, "Organization not found.");
  if (tenant.lifecycleStatus !== TenantLifecycleStatus.ACTIVE) throw new AppError(status.CONFLICT, "Suspended or archived organizations cannot be opened in support mode. Reactivate the organization first.");
  if (tenant.user.role !== UserRole.ADMIN || tenant.user.status !== AccountStatus.ACTIVE || !tenant.user.emailVerified) {
    throw new AppError(status.CONFLICT, "The organization owner must be active and verified before support mode can start.");
  }

  try {
    const existingId = await redis.get(actorKey(input.supportAdminId));
    if (existingId && await redis.get(sessionKey(existingId))) {
      throw new AppError(status.CONFLICT, "End your current support mode session before opening another organization.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw redisUnavailable();
  }

  const id = randomUUID();
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + ttl * 1000);
  const session: PersistedSupportSession = {
    id,
    supportAdminId: input.supportAdminId,
    organizationId: tenant.id,
    targetUserId: tenant.user.id,
    targetName: tenant.user.name,
    targetEmail: tenant.user.email,
    businessName: tenant.businessName,
    reason,
    readOnly: true,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  try {
    const multi = redis.multi();
    multi.setex(sessionKey(id), ttl, JSON.stringify(session));
    multi.setex(actorKey(input.supportAdminId), ttl, id);
    await multi.exec();
  } catch { throw redisUnavailable(); }

  const token = jwtUtils.createToken({ typ: "support_mode", sessionId: id, supportAdminId: input.supportAdminId, organizationId: tenant.id, targetUserId: tenant.user.id }, ACCESS_TOKEN_SECRET, { expiresIn: `${ttl}s` } as SignOptions);
  await writeSuperAdminAudit({
    actorUserId: input.supportAdminId,
    tenantAdminId: tenant.id,
    targetUserId: tenant.user.id,
    action: "TENANT_SUPPORT_MODE_STARTED",
    reason,
    metadata: { sessionId: id, readOnly: true, expiresAt: expiresAt.toISOString(), durationMinutes: ttl / 60, ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null },
  });
  return { token, session: { ...session, targetRole: UserRole.ADMIN } };
};

export const verifySupportMode = async (token: string, expectedSupportAdminId?: string): Promise<ActiveSupportMode> => {
  const payload = parseToken(token);
  if (expectedSupportAdminId && payload.supportAdminId !== expectedSupportAdminId) {
    throw new AppError(status.FORBIDDEN, "This support mode session belongs to another Super Admin.");
  }
  const session = await getPersisted(payload.sessionId);
  if (session.supportAdminId !== payload.supportAdminId || session.organizationId !== payload.organizationId || session.targetUserId !== payload.targetUserId) {
    throw new AppError(status.UNAUTHORIZED, "Support mode state does not match its signed credential.", { code: "SUPPORT_MODE_INVALID", retryable: false });
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) throw new AppError(status.UNAUTHORIZED, "Support mode has expired.", { code: "SUPPORT_MODE_EXPIRED", retryable: false });
  await assertTargetStillAvailable(session);
  return { ...session, targetRole: UserRole.ADMIN };
};

export const currentSupportMode = async (token: string, supportAdminId: string) => verifySupportMode(token, supportAdminId);

export const endSupportMode = async (token: string, supportAdminId: string, metadata?: { ipAddress?: string | null; userAgent?: string | null }) => {
  const session = await verifySupportMode(token, supportAdminId);
  try { await redis.del(sessionKey(session.id), actorKey(supportAdminId)); }
  catch { throw redisUnavailable(); }
  await writeSuperAdminAudit({
    actorUserId: supportAdminId,
    tenantAdminId: session.organizationId,
    targetUserId: session.targetUserId,
    action: "TENANT_SUPPORT_MODE_ENDED",
    reason: "Read-only support mode ended by Super Admin.",
    metadata: { sessionId: session.id, readOnly: true, ipAddress: metadata?.ipAddress ?? null, userAgent: metadata?.userAgent ?? null },
  });
  return { ended: true, organizationId: session.organizationId };
};

export const getSupportModeFromRequest = async (req: Request, supportAdminId: string) => {
  const token = CookieUtils.getCookie(req, SUPPORT_MODE_COOKIE);
  if (!token) return null;
  try {
    return await verifySupportMode(token, supportAdminId);
  } catch (error) {
    // Expired/ended/invalid support credentials must never strand the actual
    // Super Admin in the tenant UI. Redis availability errors remain fail-closed.
    if (error instanceof AppError && error.statusCode === status.SERVICE_UNAVAILABLE) throw error;
    if (error instanceof AppError && error.statusCode === status.UNAUTHORIZED) return null;
    throw error;
  }
};

export const assertSupportModeReadOnly = (req: Request) => {
  if (!req.supportMode) return;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return;
  throw new AppError(status.FORBIDDEN, "Read-only support mode blocks write operations. Exit support mode to make changes.", {
    code: "SUPPORT_MODE_READ_ONLY",
    retryable: false,
  });
};

export const getSupportSessionSnapshot = async (mode: ActiveSupportMode, originalSessionToken?: string | null) => {
  if (!originalSessionToken?.trim()) throw new AppError(status.UNAUTHORIZED, "The Super Admin session is missing.");
  const actorSession = await prisma.session.findFirst({ where: { token: originalSessionToken, userId: mode.supportAdminId, expiresAt: { gt: new Date() } }, select: { expiresAt: true } });
  if (!actorSession) throw new AppError(status.UNAUTHORIZED, "The Super Admin session expired or was revoked.");
  const tenant = await prisma.adminProfile.findUniqueOrThrow({ where: { id: mode.organizationId }, select: { onboardingCompletedAt: true, onboardingCompletedSteps: true, user: { select: { id: true, name: true, email: true, image: true, role: true, status: true, emailVerified: true, needPasswordChange: true } } } });
  return {
    authenticated: true as const,
    user: { ...tenant.user, role: UserRole.ADMIN },
    // Support mode is a diagnostic view, never an onboarding impersonation.
    onboarding: { completed: true, currentStep: null },
    needPasswordChange: false,
    session: { expiresAt: new Date(Math.min(actorSession.expiresAt.getTime(), new Date(mode.expiresAt).getTime())) },
    supportMode: { id: mode.id, organizationId: mode.organizationId, businessName: mode.businessName, readOnly: true as const, expiresAt: mode.expiresAt, reason: mode.reason, supportAdminId: mode.supportAdminId },
  };
};

export const SupportModeService = {
  start: startSupportMode,
  current: currentSupportMode,
  end: endSupportMode,
  verify: verifySupportMode,
  fromRequest: getSupportModeFromRequest,
  assertReadOnly: assertSupportModeReadOnly,
  sessionSnapshot: getSupportSessionSnapshot,
};
