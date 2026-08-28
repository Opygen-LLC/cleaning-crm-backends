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
import { REFRESH_TOKEN_SECRET } from "../../config/ENV";
import {
    AccountStatus,
    StaffStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { AccountProvisioningService } from "./accountProvisioning.service";
import { AccountIntegrityService } from "./accountIntegrity.service";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { AuthEmailOutbox } from "../../lib/outbox/authEmailOutbox";
import { randomBytes, randomUUID } from "node:crypto";
import { AUTH_ERROR_CODES } from "./auth.codes";
import { ACCOUNT_SETUP_STEPS } from "../Admin/admin.constant";

//? Max sessions per user
const MAX_SESSIONS = 3;
const BETTER_AUTH_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const revokeSessionSilently = async (sessionToken?: string | null): Promise<void> => {
    if (!sessionToken?.trim()) return;
    await prisma.session.deleteMany({ where: { token: sessionToken } }).catch(() => undefined);
};

const assertAccountCanUseAuthenticatedApp = (user: {
    status: AccountStatus;
    role: UserRole;
    emailVerified: boolean;
    staff?: { status: StaffStatus } | null;
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

    if (
        user.role === UserRole.STAFF &&
        user.staff?.status === StaffStatus.DEACTIVE
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
}: IRegisterUserPayload) => {
    const platformConfig = await getPlatformConfig();
    if (!platformConfig.registrationOpen) {
        throw new AppError(
            status.FORBIDDEN,
            "New registrations are currently closed. Please contact support.",
        );
    }

    return AccountProvisioningService.provisionRegisteredAdmin({
        businessName,
        name,
        email,
        password,
        trialDays: platformConfig.defaultTrialDays,
        // Optional 2-step wizard fields — undefined if not provided
        mobileNumber,
        businessType,
        licenseNumber,
    });
};

const login = async ({ email, password }: ILoginUserPayload) => {
    const normalizedEmail = email.trim().toLowerCase();

    // Better Auth is the credential/session authority. Its successful sign-in
    // response already contains the freshly-loaded user and persisted opaque
    // session token, so re-reading both rows here only adds database latency.
    const signIn = await auth.api.signInEmail({
        body: { email: normalizedEmail, password },
    });

    const sessionToken =
        typeof signIn?.token === "string" && signIn.token.trim()
            ? signIn.token
            : null;

    if (!signIn?.user?.id || !sessionToken) {
        await revokeSessionSilently(sessionToken);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Your credentials were accepted, but a secure session could not be created.",
            { code: AUTH_ERROR_CODES.AUTH_SESSION_NOT_CREATED, retryable: true },
        );
    }

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

        // STAFF has one application-specific state that Better Auth does not
        // carry in its user row. ADMIN/SUPER_ADMIN therefore need no extra read.
        const staff = signedInUser.role === UserRole.STAFF
            ? await prisma.staffProfile.findUnique({
                where: { userId: signedInUser.id },
                select: { status: true },
            })
            : null;

        assertAccountCanUseAuthenticatedApp({
            status: signedInUser.status,
            role: signedInUser.role,
            emailVerified: signedInUser.emailVerified,
            staff,
        });

        const tokenPayload = {
            userId: signedInUser.id,
            role: signedInUser.role,
            name: signedInUser.name,
            email: signedInUser.email,
            emailVerified: signedInUser.emailVerified,
        };

        let accessToken: string;
        let refreshToken: string;
        try {
            accessToken = tokenUtils.getAccessToken(tokenPayload);
            refreshToken = tokenUtils.getRefreshToken(tokenPayload);
        } catch {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "The secure login tokens could not be created.",
                { code: AUTH_ERROR_CODES.AUTH_TOKEN_CREATION_FAILED, retryable: true },
            );
        }

        // Keep the current session plus the newest MAX_SESSIONS-1 active
        // sessions. One SQL statement replaces count -> list -> delete and does
        // not put session housekeeping on a multi-round-trip critical path.
        const keepOtherSessions = Math.max(0, MAX_SESSIONS - 1);
        await prisma.$executeRaw`
            WITH excess_sessions AS (
                SELECT id
                FROM "session"
                WHERE "userId" = ${signedInUser.id}
                  AND token <> ${sessionToken}
                  AND "expiresAt" > NOW()
                ORDER BY "createdAt" DESC
                OFFSET ${keepOtherSessions}
            )
            DELETE FROM "session"
            WHERE id IN (SELECT id FROM excess_sessions)
        `;

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
        role: UserRole;
        status: AccountStatus;
        needPasswordChange: boolean;
        staffStatus: StaffStatus | null;
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
            u."emailVerified",
            u.role::text AS role,
            u.status::text AS status,
            u."needPasswordChange",
            sp.status::text AS "staffStatus",
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
        staff: account.staffStatus ? { status: account.staffStatus } : null,
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

    const verifiedRefreshToken = jwtUtils.verifyToken(
        refreshToken,
        REFRESH_TOKEN_SECRET,
    );

    if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh token is invalid or expired.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
        );
    }

    const data = verifiedRefreshToken.data as JwtPayload;
    const refreshUserId =
        typeof data.userId === "string" && data.userId.trim()
            ? data.userId
            : null;

    if (!refreshUserId) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh token is invalid.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
        );
    }

    // One joined session lookup validates revocation/expiry and refreshes the
    // current account state. This replaces the previous session read followed
    // by a separate user read, while still making suspensions/role changes take
    // effect on the next refresh.
    const session = await prisma.session.findFirst({
        where: {
            token: sessionToken,
            userId: refreshUserId,
            expiresAt: { gt: new Date() },
        },
        select: {
            id: true,
            token: true,
            user: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    emailVerified: true,
                    role: true,
                    status: true,
                    staff: { select: { status: true } },
                },
            },
        },
    });

    if (!session) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh session has expired or was revoked.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_EXPIRED, retryable: false },
        );
    }

    const user = session.user;
    assertAccountCanUseAuthenticatedApp(user);

    const tokenPayload = {
        userId: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
    };

    const newAccessToken = tokenUtils.getAccessToken(tokenPayload);
    const newRefreshToken = tokenUtils.getRefreshToken(tokenPayload);

    const { token } = await prisma.session.update({
        where: { id: session.id },
        data: {
            expiresAt: new Date(Date.now() + BETTER_AUTH_SESSION_TTL_MS),
            updatedAt: new Date(),
        },
        select: { token: true },
    });

    return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        sessionToken: token,
    };
};

const verifyEmail = async (email: string, otp: string) => {
    // Resolve identity and credential ownership first. ADMIN provisioning is
    // checked before the OTP is consumed so an incomplete tenant cannot become
    // stuck in a verified-but-unusable state.
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            role: true,
            accounts: {
                where: { providerId: "credential" },
                select: { id: true },
                take: 1,
            },
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found.");
    }

    if (user.accounts.length === 0) {
        throw new AppError(
            status.BAD_REQUEST,
            "Email verification is not allowed for social login accounts.",
        );
    }

    if (user.role === UserRole.ADMIN) {
        // Activation readiness remains a server-side integrity gate. Its routing
        // state is intentionally not returned by verify-email; /auth/session is
        // the sole browser authority after the cookies are issued.
        await AccountIntegrityService.assertAdminReadyForActivation(user.id);
    }

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
        where: { email },
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

    return {
        ...result,
        token: sessionToken,
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
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

    await AuthEmailOutbox.enqueueEmailVerification({
        userId: user.id,
        email: user.email,
    });
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
        where: {
            email,
        },
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

    await prisma.session.deleteMany({
        where: {
            userId: isUserExist.id,
        },
    });
};

const changePassword = async (
    payload: IChangePasswordPayload,
    sessionToken: string,
) => {
    const session = await auth.api.getSession({
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    if (!session) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token");
    }

    const isGoogleAccount = await prisma.account.count({
        where: {
            userId: session.user.id,
            providerId: "google",
        },
    });

    if (isGoogleAccount > 0) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password cannot be changed for Google accounts.",
        );
    }

    const { currentPassword, newPassword } = payload;

    const result = await auth.api.changePassword({
        body: {
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
        },
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    // ✅ Clear the forced-password-change flag now that the staff member has
    //    chosen their own password.  We do this after the password change
    //    succeeds so the flag is only cleared on a real credential update.
    await prisma.user.update({
        where: { id: session.user.id },
        data: { needPasswordChange: false },
    });

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };

    const accessToken = tokenUtils.getAccessToken(tokenPayload);
    const refreshToken = tokenUtils.getRefreshToken(tokenPayload);

    return {
        ...result,
        accessToken,
        refreshToken,
    };
};

const logout = async (sessionToken?: string) => {
    // Logout is deliberately idempotent. Clearing browser credentials should
    // still succeed if the server-side session has already expired/revoked.
    if (!sessionToken) return { success: true };

    try {
        return await auth.api.signOut({
            headers: new Headers({
                Authorization: `Bearer ${sessionToken}`,
            }),
        });
    } catch {
        return { success: true };
    }
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
