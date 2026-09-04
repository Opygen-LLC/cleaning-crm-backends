import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import {
    IRegisterUserPayload,
    ILoginUserPayload,
    IChangePasswordPayload,
} from "./auth.interface";
import { auth } from "../../lib/auth";
import { tokenUtils } from "../../lib/utils/token";
import { IRequestUser } from "../../types/requestUser.interface";
import { JwtPayload } from "jsonwebtoken";
import { jwtUtils } from "../../lib/utils/jwt";
import { REFRESH_TOKEN_REUSE_GRACE_MS, REFRESH_TOKEN_SECRET } from "../../config/ENV";
import {
    AccountStatus,
    StaffStatus,
    TenantLifecycleStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { AccountProvisioningService } from "./accountProvisioning.service";
import { AccountIntegrityService } from "./accountIntegrity.service";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { AuthEmailOutbox } from "../../lib/outbox/authEmailOutbox";
import { randomBytes, randomUUID } from "node:crypto";
import { AUTH_ERROR_CODES } from "./auth.codes";
import { ACCOUNT_SETUP_STEPS } from "../Admin/admin.constant";
import logger from "../../lib/logger";
import { logAuthLoginStage } from "./authLoginDiagnostics";
import {
    bindRefreshCredentialToSession,
    createRefreshFamilyId,
    hashRefreshCredential,
    revokeAllSessionsForUser,
    revokeOtherSessionsForUser,
    revokeSessionByToken,
    revokeSessionByTokenWithOwner,
    type SessionRequestMetadata,
} from "./sessionSecurity.service";
import { invalidateRuntimeAuth, invalidateRuntimeSessionValidities, invalidateRuntimeSessionValidity } from "../../lib/cache/authRuntimeCache";
import { invalidatePrivateResponseCacheForUser } from "../../middlewares/privateResponseCache";

//? Max sessions per user
const MAX_SESSIONS = 3;
const BETTER_AUTH_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const revokeSessionSilently = async (sessionToken?: string | null): Promise<void> => {
    if (!sessionToken?.trim()) return;
    await revokeSessionByToken(sessionToken).catch(() => undefined);
};

const getBetterAuthErrorCode = (error: unknown): string => {
    if (!error || typeof error !== "object") return "";
    const value = error as { code?: unknown; body?: { code?: unknown } };
    const raw = typeof value.body?.code === "string"
        ? value.body.code
        : typeof value.code === "string"
            ? value.code
            : "";
    return raw.trim().toUpperCase();
};

const verificationQueueDedupeKey = (source: "login" | "resend", userId: string): string => {
    // Rate limits are the primary abuse control. The 30-second bucket prevents
    // double-clicks/retries from queuing multiple OTP jobs inside one window.
    const bucket = Math.floor(Date.now() / 30_000);
    return `${source}-email-verification:${userId}:${bucket}`;
};

const queueVerificationForUnverifiedLogin = async (email: string): Promise<void> => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerified: true },
    });

    // Better Auth only reports EMAIL_NOT_VERIFIED after validating credentials,
    // but keep this check defensive and enumeration-safe.
    if (!user || user.emailVerified) return;

    await AuthEmailOutbox.enqueueEmailVerification(
        { userId: user.id, email: user.email },
        { dedupeKey: verificationQueueDedupeKey("login", user.id) },
    );
};

const assertAccountCanUseAuthenticatedApp = (user: {
    status: AccountStatus;
    role: UserRole;
    emailVerified: boolean;
    admin?: { lifecycleStatus: TenantLifecycleStatus } | null;
    staff?: {
        status: StaffStatus;
        manuallyInactive: boolean;
        admin?: { lifecycleStatus: TenantLifecycleStatus; user: { status: AccountStatus } } | null;
    } | null;
}): void => {
    if (!user.emailVerified) {
        throw new AppError(
            status.FORBIDDEN,
            "Please verify your email before signing in.",
            { code: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED, retryable: false },
        );
    }

    if (user.status === AccountStatus.SUSPENDED) {
        throw new AppError(
            status.FORBIDDEN,
            "Your account is suspended. Please contact support.",
            { code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, retryable: false },
        );
    }

    if (user.status === AccountStatus.DELETED) {
        throw new AppError(
            status.FORBIDDEN,
            "This account is no longer active.",
            { code: AUTH_ERROR_CODES.ACCOUNT_DISABLED, retryable: false },
        );
    }

    if (user.status !== AccountStatus.ACTIVE) {
        throw new AppError(
            status.FORBIDDEN,
            "This account is not active yet.",
            { code: AUTH_ERROR_CODES.ACCOUNT_NOT_ACTIVE, retryable: false },
        );
    }

    if (user.role === UserRole.ADMIN && user.admin) {
        if (String(user.admin.lifecycleStatus) === "PENDING_DELETION") {
            throw new AppError(status.FORBIDDEN, "This organization is pending permanent deletion and is locked.", { code: "TENANT_PENDING_DELETION", retryable: false });
        }
        if (user.admin.lifecycleStatus === TenantLifecycleStatus.ARCHIVED) {
            throw new AppError(status.FORBIDDEN, "Your business account has been archived.", { code: "TENANT_ARCHIVED", retryable: false });
        }
        if (user.admin.lifecycleStatus === TenantLifecycleStatus.SUSPENDED) {
            throw new AppError(status.FORBIDDEN, "Your business account has been suspended. Please contact support.", { code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, retryable: false });
        }
    }

    if (user.role === UserRole.STAFF && user.staff?.admin) {
        if (String(user.staff.admin.lifecycleStatus) === "PENDING_DELETION") {
            throw new AppError(status.FORBIDDEN, "Your business account is pending permanent deletion.", { code: "TENANT_PENDING_DELETION", retryable: false });
        }
        if (user.staff.admin.lifecycleStatus === TenantLifecycleStatus.ARCHIVED) {
            throw new AppError(status.FORBIDDEN, "Your business account has been archived.", { code: "TENANT_ARCHIVED", retryable: false });
        }
        if (user.staff.admin.lifecycleStatus === TenantLifecycleStatus.SUSPENDED || user.staff.admin.user.status === AccountStatus.SUSPENDED) {
            throw new AppError(status.FORBIDDEN, "Your business account has been suspended. Please contact support.", { code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, retryable: false });
        }
    }

    if (
        user.role === UserRole.STAFF &&
        user.staff?.manuallyInactive
    ) {
        throw new AppError(
            status.FORBIDDEN,
            "Your staff access has been disabled. Please contact your administrator.",
            { code: AUTH_ERROR_CODES.ACCOUNT_SUSPENDED, retryable: false },
        );
    }
};

/**
 * Email OTP verification is configured to auto-sign-in, so Better Auth should
 * normally return a session token. This fallback guarantees the application
 * contract even if a rolling Better Auth/plugin version verifies the email but
 * omits the token from the server API result. Better Auth sessions are opaque
 * random tokens backed by the Session table, so the fallback remains fully
 * server-side and HttpOnly when the controller sets the cookie.
 */
const ensureVerifiedSessionToken = async (
    userId: string,
    returnedToken?: string | null,
): Promise<string> => {
    if (typeof returnedToken === "string" && returnedToken.trim()) {
        return returnedToken;
    }

    try {
        const session = await prisma.session.create({
            data: {
                id: randomUUID(),
                userId,
                token: randomBytes(32).toString("base64url"),
                expiresAt: new Date(Date.now() + BETTER_AUTH_SESSION_TTL_MS),
            },
            select: { token: true },
        });

        return session.token;
    } catch {
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Email verified, but the authenticated session could not be established.",
            {
                code: AUTH_ERROR_CODES.AUTH_VERIFICATION_SESSION_FAILED,
                retryable: true,
            },
        );
    }
};

/**
 * Registration has one canonical persistence path: AccountProvisioningService.
 * That service creates the Better Auth credential user/account, tenant profile,
 * website/pages/revision, trial and verification-email outbox row in one Prisma
 * transaction. No Better Auth sign-up call or compensating delete happens here.
 */
const register = async ({
    businessName,
    name,
    email,
    password,
    mobileNumber,
    businessType,
    licenseNumber,
}: IRegisterUserPayload, metadata: SessionRequestMetadata = {}) => {
    const platformConfig = await getPlatformConfig();
    if (!platformConfig.registrationOpen) {
        throw new AppError(
            status.FORBIDDEN,
            "New registrations are currently closed. Please contact support.",
        );
    }

    const verificationRequired = platformConfig.authentication?.requireEmailOtpVerification ?? true;
    const provisioned = await AccountProvisioningService.provisionRegisteredAdmin({
        businessName,
        name,
        email,
        password,
        trialDays: platformConfig.defaultTrialDays,
        requireEmailVerification: verificationRequired,
        // Optional 2-step wizard fields — undefined if not provided
        mobileNumber,
        businessType,
        licenseNumber,
    });

    if (verificationRequired) {
        return { ...provisioned, verificationRequired: true as const, authentication: null };
    }

    // Verification-disabled registrations still use the canonical Better Auth
    // login path so the browser receives the same rotated refresh/session
    // credentials as a normal login.
    const authentication = await login({ email, password }, metadata);
    return { ...provisioned, verificationRequired: false as const, authentication };
};

const login = async (
    { email, password }: ILoginUserPayload,
    metadata: SessionRequestMetadata = {},
) => {
    const normalizedEmail = email.trim().toLowerCase();

    // Better Auth remains the credential/session authority. Its successful
    // sign-in gives us the persisted opaque session token; Phase 5 only binds
    // our rotating refresh credential to that session row.
    let signIn: Awaited<ReturnType<typeof auth.api.signInEmail>>;
    try {
        signIn = await auth.api.signInEmail({
            body: { email: normalizedEmail, password },
        });
    } catch (error) {
        const authCode = getBetterAuthErrorCode(error);
        if (authCode === AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED) {
            await queueVerificationForUnverifiedLogin(normalizedEmail);
            logAuthLoginStage("AUTH_LOGIN_FAILED", {
                errorCode: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
            });
            throw new AppError(
                status.FORBIDDEN,
                "Please verify your email before signing in. A new verification code has been queued.",
                { code: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED, retryable: false },
            );
        }

        logAuthLoginStage("AUTH_LOGIN_FAILED", {
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
    }
    logAuthLoginStage("AUTH_CREDENTIAL_ACCEPTED");

    const sessionToken =
        typeof signIn?.token === "string" && signIn.token.trim()
            ? signIn.token
            : null;

    if (!signIn?.user?.id || !sessionToken) {
        logAuthLoginStage("AUTH_LOGIN_FAILED", {
            errorCode: AUTH_ERROR_CODES.AUTH_SESSION_NOT_CREATED,
        });
        await revokeSessionSilently(sessionToken);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Your credentials were accepted, but a secure session could not be created.",
            { code: AUTH_ERROR_CODES.AUTH_SESSION_NOT_CREATED, retryable: true },
        );
    }

    logAuthLoginStage("AUTH_SESSION_CREATED");

    try {
        const signedInUser = signIn.user as typeof signIn.user & {
            role: UserRole;
            status: AccountStatus;
            needPasswordChange?: boolean;
        };

        if (signedInUser.email.toLowerCase() !== normalizedEmail) {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "The authenticated identity could not be reconciled with the application account.",
                { code: AUTH_ERROR_CODES.AUTH_IDENTITY_STATE_INVALID, retryable: true },
            );
        }

        const [admin, staff] = await Promise.all([
            signedInUser.role === UserRole.ADMIN
                ? prisma.adminProfile.findUnique({ where: { userId: signedInUser.id }, select: { lifecycleStatus: true } })
                : Promise.resolve(null),
            signedInUser.role === UserRole.STAFF
                ? prisma.staffProfile.findUnique({
                    where: { userId: signedInUser.id },
                    select: { status: true, manuallyInactive: true, admin: { select: { lifecycleStatus: true, user: { select: { status: true } } } } },
                })
                : Promise.resolve(null),
        ]);

        assertAccountCanUseAuthenticatedApp({
            status: signedInUser.status,
            role: signedInUser.role,
            emailVerified: signedInUser.emailVerified,
            admin,
            staff,
        });
        logAuthLoginStage("AUTH_ACCOUNT_VALIDATED");

        const tokenPayload = {
            userId: signedInUser.id,
            role: signedInUser.role,
            name: signedInUser.name,
            email: signedInUser.email,
            emailVerified: signedInUser.emailVerified,
        };

        const refreshFamilyId = createRefreshFamilyId();
        let accessToken: string;
        let refreshToken: string;
        try {
            accessToken = tokenUtils.getAccessToken(tokenPayload);
            refreshToken = tokenUtils.getRefreshToken(tokenPayload, refreshFamilyId);
        } catch {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "The secure login tokens could not be created.",
                { code: AUTH_ERROR_CODES.AUTH_TOKEN_CREATION_FAILED, retryable: true },
            );
        }
        logAuthLoginStage("AUTH_TOKEN_PAIR_CREATED");

        const binding = await bindRefreshCredentialToSession({
            userId: signedInUser.id,
            sessionToken,
            refreshToken,
            refreshFamilyId,
            maxSessions: MAX_SESSIONS,
            metadata,
        });
        if (!binding.bound) {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "Your credentials were accepted, but the secure session could not be finalized.",
                { code: AUTH_ERROR_CODES.AUTH_SESSION_NOT_CREATED, retryable: true },
            );
        }

        logAuthLoginStage("AUTH_REFRESH_BOUND");
        invalidateRuntimeAuth(signedInUser.id);

        return {
            user: {
                id: signedInUser.id,
                name: signedInUser.name,
                email: signedInUser.email,
                role: signedInUser.role,
                status: signedInUser.status,
            },
            sessionToken,
            accessToken,
            refreshToken,
        };
    } catch (error) {
        const errorCode = error instanceof AppError ? error.code ?? null : null;
        logAuthLoginStage("AUTH_LOGIN_FAILED", {
            errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        await revokeSessionSilently(sessionToken);
        throw error;
    }
};

const me = async (user: IRequestUser) => {
    const isUserExist = await prisma.user.findUnique({
        where: {
            id: user.id,
        },
        include: {
            admin: true,
            staff: true,
        },
    });

    if (!isUserExist) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    return isUserExist;
};

/**
 * Canonical browser-session snapshot. This endpoint is intentionally narrower
 * than /auth/me: it validates the Better Auth session and selects only the
 * account/onboarding fields required to decide where the browser may navigate.
 * It is the authoritative contract used after login, OTP verification, refresh
 * and dashboard bootstrap.
 */
const session = async (user: IRequestUser, sessionToken?: string | null) => {
    if (!sessionToken?.trim()) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The authenticated session is missing.",
            { code: AUTH_ERROR_CODES.INVALID_SESSION, retryable: false },
        );
    }

    type SessionSnapshotRow = {
        expiresAt: Date;
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        image: string | null;
        role: UserRole;
        status: AccountStatus;
        needPasswordChange: boolean;
        staffStatus: StaffStatus | null;
        staffManuallyInactive: boolean | null;
        onboardingCompletedAt: Date | null;
        onboardingCompletedSteps: string[] | null;
    };

    // One SQL statement is the canonical browser-session read. Using explicit
    // joins avoids Prisma relation-load fan-out while selecting only the fields
    // required for auth/routing. /auth/me remains the separate full-profile API.
    const rows = await prisma.$queryRaw<SessionSnapshotRow[]>`
        SELECT
            s."expiresAt",
            u.id,
            u.name,
            u.email,
            u.image,
            u."emailVerified",
            u.role::text AS role,
            u.status::text AS status,
            u."needPasswordChange",
            sp.status::text AS "staffStatus",
            sp."manuallyInactive" AS "staffManuallyInactive",
            ap."onboardingCompletedAt",
            ap."onboardingCompletedSteps"
        FROM "session" s
        JOIN "user" u ON u.id = s."userId"
        LEFT JOIN "StaffProfile" sp ON sp."userId" = u.id
        LEFT JOIN "AdminProfile" ap ON ap."userId" = u.id
        WHERE s.token = ${sessionToken}
          AND s."userId" = ${user.id}
          AND s."expiresAt" > NOW()
        LIMIT 1
    `;

    const account = rows[0];
    if (!account) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The authenticated session has expired or was revoked.",
            { code: AUTH_ERROR_CODES.INVALID_SESSION, retryable: false },
        );
    }

    assertAccountCanUseAuthenticatedApp({
        status: account.status,
        role: account.role,
        emailVerified: account.emailVerified,
        staff: account.staffStatus ? { status: account.staffStatus, manuallyInactive: Boolean(account.staffManuallyInactive) } : null,
    });

    if (account.role === UserRole.ADMIN && account.onboardingCompletedSteps == null) {
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "The authenticated admin profile is incomplete.",
            { code: AUTH_ERROR_CODES.AUTH_IDENTITY_STATE_INVALID, retryable: true },
        );
    }

    let onboardingCompleted = true;
    let currentStep: string | null = null;

    if (account.role === UserRole.ADMIN) {
        onboardingCompleted = account.onboardingCompletedAt != null;
        if (!onboardingCompleted) {
            const completed = new Set(account.onboardingCompletedSteps ?? []);
            currentStep =
                ACCOUNT_SETUP_STEPS.find((step) => !completed.has(step.key))?.key ??
                ACCOUNT_SETUP_STEPS[ACCOUNT_SETUP_STEPS.length - 1]?.key ??
                null;
        }
    }

    return {
        authenticated: true as const,
        user: {
            id: account.id,
            name: account.name,
            email: account.email,
            image: account.image,
            role: account.role,
            status: account.status,
            emailVerified: account.emailVerified,
        },
        onboarding: {
            completed: onboardingCompleted,
            currentStep,
        },
        needPasswordChange: account.needPasswordChange,
        session: {
            expiresAt: account.expiresAt,
        },
    };
};

const getNewToken = async (
    refreshToken: string,
    sessionToken?: string,
) => {
    if (!sessionToken?.trim()) {
        throw new AppError(
            status.UNAUTHORIZED,
            "Refresh session is missing.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_MISSING, retryable: false },
        );
    }

    const verifiedRefreshToken = jwtUtils.verifyToken(refreshToken, REFRESH_TOKEN_SECRET);
    if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh token is invalid or expired.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
        );
    }

    const data = verifiedRefreshToken.data as JwtPayload;
    const refreshUserId = typeof data.userId === "string" && data.userId.trim() ? data.userId : null;
    const claimedFamilyId = typeof data.refreshFamilyId === "string" && data.refreshFamilyId.trim()
        ? data.refreshFamilyId
        : null;
    const tokenType = typeof data.tokenType === "string" ? data.tokenType : null;

    if (!refreshUserId || (tokenType && tokenType !== "refresh")) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh token is invalid.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
        );
    }

    const presentedHash = hashRefreshCredential(refreshToken);
    type LockedSessionRow = {
        id: string;
        token: string;
        refreshTokenHash: string | null;
        previousRefreshTokenHash: string | null;
        refreshFamilyId: string | null;
        refreshRotatedAt: Date | null;
        userId: string;
        name: string;
        email: string;
        emailVerified: boolean;
        image: string | null;
        role: UserRole;
        status: AccountStatus;
        staffStatus: StaffStatus | null;
        staffManuallyInactive: boolean | null;
    };

    type RotationResult =
        | { kind: "rotated"; accessToken: string; refreshToken: string; sessionToken: string }
        | { kind: "grace"; accessToken: string; refreshToken: null; sessionToken: string }
        | { kind: "reuse"; userId: string; sessionId: string; familyId: string | null; revokedTokens: string[] };

    const rotation = await prisma.$transaction(async (tx): Promise<RotationResult> => {
        const rows = await tx.$queryRaw<LockedSessionRow[]>`
            SELECT
                s.id, s.token, s."refreshTokenHash", s."previousRefreshTokenHash",
                s."refreshFamilyId", s."refreshRotatedAt",
                u.id AS "userId", u.name, u.email, u."emailVerified",
                u.role::text AS role, u.status::text AS status,
                sp.status::text AS "staffStatus", sp."manuallyInactive" AS "staffManuallyInactive"
            FROM "session" s
            JOIN "user" u ON u.id = s."userId"
            LEFT JOIN "StaffProfile" sp ON sp."userId" = u.id
            WHERE s.token = ${sessionToken}
              AND s."userId" = ${refreshUserId}
              AND s."expiresAt" > NOW()
            LIMIT 1
            FOR UPDATE OF s
        `;

        const current = rows[0];
        if (!current) {
            throw new AppError(
                status.UNAUTHORIZED,
                "The refresh session has expired or was revoked.",
                { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
            );
        }

        assertAccountCanUseAuthenticatedApp({
            status: current.status,
            role: current.role,
            emailVerified: current.emailVerified,
            staff: current.staffStatus ? { status: current.staffStatus, manuallyInactive: Boolean(current.staffManuallyInactive) } : null,
        });

        const familyMismatch = Boolean(
            claimedFamilyId && current.refreshFamilyId && claimedFamilyId !== current.refreshFamilyId,
        );
        const currentHashMatches = !current.refreshTokenHash || current.refreshTokenHash === presentedHash;
        const withinGrace = Boolean(
            current.previousRefreshTokenHash === presentedHash &&
            current.refreshRotatedAt &&
            Date.now() - current.refreshRotatedAt.getTime() <= REFRESH_TOKEN_REUSE_GRACE_MS,
        );

        const tokenPayload = {
            userId: current.userId,
            role: current.role,
            name: current.name,
            email: current.email,
            emailVerified: current.emailVerified,
        };

        if (!familyMismatch && !currentHashMatches && withinGrace) {
            // A near-simultaneous second refresh from another browser tab is
            // allowed only inside the tiny grace window. It receives a fresh
            // access token but DOES NOT overwrite the newly rotated refresh
            // cookie from the winning request.
            await tx.$executeRaw`
                UPDATE "session"
                SET "lastUsedAt" = NOW(),
                    "expiresAt" = ${new Date(Date.now() + BETTER_AUTH_SESSION_TTL_MS)},
                    "updatedAt" = NOW()
                WHERE id = ${current.id}
            `;
            return {
                kind: "grace",
                accessToken: tokenUtils.getAccessToken(tokenPayload),
                refreshToken: null,
                sessionToken: current.token,
            };
        }

        if (familyMismatch || !currentHashMatches) {
            type RevokedRow = { token: string };
            const revoked = current.refreshFamilyId
                ? await tx.$queryRaw<RevokedRow[]>`
                    DELETE FROM "session"
                    WHERE "refreshFamilyId" = ${current.refreshFamilyId}
                    RETURNING token
                `
                : await tx.$queryRaw<RevokedRow[]>`
                    DELETE FROM "session"
                    WHERE id = ${current.id}
                    RETURNING token
                `;
            return {
                kind: "reuse",
                userId: current.userId,
                sessionId: current.id,
                familyId: current.refreshFamilyId,
                revokedTokens: revoked.map((row) => row.token),
            };
        }

        // Existing pre-Phase-5 sessions have no stored family/hash. Upgrade
        // them lazily on first refresh; all newly issued credentials carry a
        // family identifier and a unique refreshId.
        const refreshFamilyId = current.refreshFamilyId || claimedFamilyId || createRefreshFamilyId();
        const newAccessToken = tokenUtils.getAccessToken(tokenPayload);
        const newRefreshToken = tokenUtils.getRefreshToken(tokenPayload, refreshFamilyId);
        const newHash = hashRefreshCredential(newRefreshToken);

        await tx.$executeRaw`
            UPDATE "session"
            SET "previousRefreshTokenHash" = ${current.refreshTokenHash ?? presentedHash},
                "refreshTokenHash" = ${newHash},
                "refreshFamilyId" = ${refreshFamilyId},
                "refreshRotatedAt" = NOW(),
                "lastUsedAt" = NOW(),
                "expiresAt" = ${new Date(Date.now() + BETTER_AUTH_SESSION_TTL_MS)},
                "updatedAt" = NOW()
            WHERE id = ${current.id}
        `;

        return {
            kind: "rotated",
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            sessionToken: current.token,
        };
    });

    if (rotation.kind === "reuse") {
        await invalidateRuntimeSessionValidities(rotation.revokedTokens);
        invalidateRuntimeAuth(rotation.userId);
        logger.warn("Refresh token reuse detected; session family revoked", {
            event: "auth_refresh_token_reuse",
            userId: rotation.userId,
            sessionId: rotation.sessionId,
            familyId: rotation.familyId,
            revokedSessionCount: rotation.revokedTokens.length,
        });
        throw new AppError(
            status.UNAUTHORIZED,
            "This session was revoked because an old refresh credential was reused.",
            { code: AUTH_ERROR_CODES.REFRESH_TOKEN_REUSE_DETECTED, retryable: false },
        );
    }

    return rotation;
};

const verifyEmail = async (email: string, otp: string, metadata: SessionRequestMetadata = {}) => {
    // Identity, credential ownership, and ADMIN tenant readiness are resolved
    // together in one preflight SQL statement before the OTP is consumed.
    const candidate = await AccountIntegrityService.assertEmailVerificationCandidate(email);

    const result = await auth.api.verifyEmailOTP({
        body: { email, otp },
    });

    if (!result?.user) {
        throw new AppError(status.BAD_REQUEST, "Invalid OTP.");
    }

    if (!result.user.emailVerified) {
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Email verification did not produce a verified account.",
            { code: AUTH_ERROR_CODES.EMAIL_VERIFICATION_STATE_INVALID, retryable: true },
        );
    }

    const activatedUser = await prisma.user.update({
        where: { id: candidate.id },
        data: { status: AccountStatus.ACTIVE },
        select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            role: true,
        },
    });

    const returnedSessionToken =
        typeof (result as { token?: unknown }).token === "string"
            ? (result as { token: string }).token
            : undefined;
    const sessionToken = await ensureVerifiedSessionToken(
        activatedUser.id,
        returnedSessionToken,
    );

    const tokenPayload = {
        userId: activatedUser.id,
        role: activatedUser.role,
        name: activatedUser.name,
        email: activatedUser.email,
        emailVerified: activatedUser.emailVerified,
    };

    const refreshFamilyId = createRefreshFamilyId();
    const accessToken = tokenUtils.getAccessToken(tokenPayload);
    const refreshToken = tokenUtils.getRefreshToken(tokenPayload, refreshFamilyId);
    const binding = await bindRefreshCredentialToSession({
        userId: activatedUser.id,
        sessionToken,
        refreshToken,
        refreshFamilyId,
        maxSessions: MAX_SESSIONS,
        metadata,
    });
    if (!binding.bound) {
        await revokeSessionSilently(sessionToken);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Email verified, but the authenticated session could not be finalized.",
            { code: AUTH_ERROR_CODES.AUTH_VERIFICATION_SESSION_FAILED, retryable: true },
        );
    }

    invalidateRuntimeAuth(activatedUser.id);
    return {
        ...result,
        token: sessionToken,
        accessToken,
        refreshToken,
    };
};

const resendOtp = async (email: string) => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerified: true },
    });

    // Preserve enumeration-resistant behaviour: callers receive the same 200
    // whether the account exists/already verified or a new email job was queued.
    if (!user || user.emailVerified) return;

    await AuthEmailOutbox.enqueueEmailVerification(
        {
            userId: user.id,
            email: user.email,
        },
        { dedupeKey: verificationQueueDedupeKey("resend", user.id) },
    );
};

const forgotPassword = async (email: string) => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    const passwordAccount = await prisma.account.findFirst({
        where: {
            userId: user.id,
            providerId: "credential",
        },
        select: { id: true },
    });

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password reset is not available for social login accounts.",
        );
    }

    await auth.api.requestPasswordResetEmailOTP({
        body: { email },
    });
};

const resetPassword = async (
    email: string,
    otp: string,
    newPassword: string,
) => {
    const isUserExist = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
    });

    if (!isUserExist) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    const passwordAccount = await prisma.account.findFirst({
        where: {
            userId: isUserExist.id,
            providerId: "credential",
        },
        select: { id: true },
    });

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password reset is not available for social login accounts.",
        );
    }

    await auth.api.resetPasswordEmailOTP({
        body: {
            email,
            otp,
            password: newPassword,
        },
    });

    await revokeAllSessionsForUser(isUserExist.id);
};

const changePassword = async (
    payload: IChangePasswordPayload,
    sessionToken: string,
) => {
    const session = await auth.api.getSession({
        headers: new Headers({ Authorization: `Bearer ${sessionToken}` }),
    });

    if (!session) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token", {
            code: AUTH_ERROR_CODES.INVALID_SESSION,
            retryable: false,
        });
    }

    const socialAccount = await prisma.account.findFirst({
        where: { userId: session.user.id, providerId: "google" },
        select: { id: true },
    });
    if (socialAccount) {
        throw new AppError(status.BAD_REQUEST, "Password cannot be changed for Google accounts.");
    }

    const { currentPassword, newPassword } = payload;
    const result = await auth.api.changePassword({
        body: {
            currentPassword,
            newPassword,
            // Phase 5 revokes other sessions itself so their Redis validity
            // entries are invalidated immediately instead of surviving TTL.
            revokeOtherSessions: false,
        },
        headers: new Headers({ Authorization: `Bearer ${sessionToken}` }),
    });

    const currentSessionToken =
        typeof (result as { token?: unknown }).token === "string" &&
        (result as { token: string }).token.trim()
            ? (result as { token: string }).token
            : sessionToken;

    await prisma.user.update({
        where: { id: session.user.id },
        data: { needPasswordChange: false },
    });
    await revokeOtherSessionsForUser(session.user.id, currentSessionToken);

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };
    const refreshFamilyId = createRefreshFamilyId();
    const accessToken = tokenUtils.getAccessToken(tokenPayload);
    const refreshToken = tokenUtils.getRefreshToken(tokenPayload, refreshFamilyId);
    const binding = await bindRefreshCredentialToSession({
        userId: session.user.id,
        sessionToken: currentSessionToken,
        refreshToken,
        refreshFamilyId,
        maxSessions: 1,
    });
    if (!binding.bound) {
        throw new AppError(status.UNAUTHORIZED, "The password changed, but the current session is no longer valid.", {
            code: AUTH_ERROR_CODES.INVALID_SESSION,
            retryable: false,
        });
    }

    invalidateRuntimeAuth(session.user.id);
    await invalidateRuntimeSessionValidity(currentSessionToken);

    return {
        ...result,
        token: currentSessionToken,
        accessToken,
        refreshToken,
    };
};

const logout = async (sessionToken?: string) => {
    // Logout is intentionally a short, database-authoritative path. Better Auth
    // sessions are persisted in the same Session table, so deleting the row is
    // sufficient and avoids waiting on a second sign-out abstraction.
    if (!sessionToken?.trim()) return { success: true, revoked: false };

    const { revoked, userId } = await revokeSessionByTokenWithOwner(sessionToken);

    if (userId) {
        invalidateRuntimeAuth(userId);
        await invalidatePrivateResponseCacheForUser(userId);
    }

    return { success: true, revoked };
};

const userService = {
    register,
    login,
    me,
    session,
    getNewToken,
    verifyEmail,
    resendOtp,
    forgotPassword,
    resetPassword,
    changePassword,
    logout,
};

export default userService;
