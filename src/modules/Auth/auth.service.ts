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
            { code: "EMAIL_NOT_VERIFIED", retryable: false },
        );
    }

    if (user.status === AccountStatus.SUSPENDED) {
        throw new AppError(
            status.FORBIDDEN,
            "Your account is suspended. Please contact support.",
            { code: "ACCOUNT_SUSPENDED", retryable: false },
        );
    }

    if (user.status === AccountStatus.DELETED) {
        throw new AppError(
            status.FORBIDDEN,
            "This account is no longer active.",
            { code: "ACCOUNT_DISABLED", retryable: false },
        );
    }

    if (user.status !== AccountStatus.ACTIVE) {
        throw new AppError(
            status.FORBIDDEN,
            "This account is not active yet.",
            { code: "ACCOUNT_NOT_ACTIVE", retryable: false },
        );
    }

    if (
        user.role === UserRole.STAFF &&
        user.staff?.status === StaffStatus.DEACTIVE
    ) {
        throw new AppError(
            status.FORBIDDEN,
            "Your staff access has been disabled. Please contact your administrator.",
            { code: "ACCOUNT_SUSPENDED", retryable: false },
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
                code: "AUTH_VERIFICATION_SESSION_FAILED",
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

    // Better Auth performs credential verification first and intentionally
    // returns the same invalid-credential error for unknown users/bad passwords.
    // Application/account state is reconciled only after credentials succeed.
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
            { code: "AUTH_SESSION_NOT_CREATED", retryable: true },
        );
    }

    // From this point onward the newly-created Better Auth session is treated
    // as provisional. Any application/database/token failure revokes it so the
    // server never returns (or leaves behind) a partially-completed login.
    try {
        const user = await prisma.user.findUnique({
            where: { id: signIn.user.id },
            select: {
                id: true,
                name: true,
                email: true,
                emailVerified: true,
                role: true,
                status: true,
                needPasswordChange: true,
                staff: { select: { status: true } },
                admin: { select: { onboardingCompletedAt: true } },
            },
        });

        if (!user || user.email.toLowerCase() !== normalizedEmail) {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "The authenticated identity could not be reconciled with the application account.",
                { code: "AUTH_IDENTITY_STATE_INVALID", retryable: true },
            );
        }

        assertAccountCanUseAuthenticatedApp(user);

        const now = new Date();
        const persistedSession = await prisma.session.findUnique({
            where: { token: sessionToken },
            select: { id: true, userId: true, expiresAt: true },
        });

        if (
            !persistedSession ||
            persistedSession.userId !== user.id ||
            persistedSession.expiresAt <= now
        ) {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "Your credentials were accepted, but the secure session was not persisted.",
                { code: "AUTH_SESSION_NOT_CREATED", retryable: true },
            );
        }

        const tokenPayload = {
            userId: user.id,
            role: user.role,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
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
                { code: "AUTH_TOKEN_CREATION_FAILED", retryable: true },
            );
        }

        // Enforce the active-session cap only after every required login
        // artifact exists. The current session is always preserved and expired
        // sessions are excluded from the active-session calculation/removal.
        const sessionCount = await prisma.session.count({
            where: {
                userId: user.id,
                expiresAt: { gt: now },
            },
        });

        if (sessionCount > MAX_SESSIONS) {
            const excess = await prisma.session.findMany({
                where: {
                    userId: user.id,
                    token: { not: sessionToken },
                    expiresAt: { gt: now },
                },
                orderBy: { createdAt: "asc" },
                take: sessionCount - MAX_SESSIONS,
                select: { id: true },
            });

            if (excess.length > 0) {
                await prisma.session.deleteMany({
                    where: { id: { in: excess.map((entry) => entry.id) } },
                });
            }
        }

        return {
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                status: user.status,
            },
            needPasswordChange: user.needPasswordChange,
            isOnboardingComplete:
                user.role === UserRole.ADMIN
                    ? user.admin?.onboardingCompletedAt != null
                    : undefined,
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

const getNewToken = async (
    refreshToken: string,
    sessionToken?: string,
) => {
    if (!sessionToken?.trim()) {
        throw new AppError(
            status.UNAUTHORIZED,
            "Refresh session is missing.",
            { code: "REFRESH_SESSION_MISSING", retryable: false },
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
            { code: "INVALID_REFRESH_TOKEN", retryable: false },
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
            { code: "INVALID_REFRESH_TOKEN", retryable: false },
        );
    }

    const session = await prisma.session.findFirst({
        where: {
            token: sessionToken,
            userId: refreshUserId,
            expiresAt: { gt: new Date() },
        },
        select: { id: true, token: true },
    });

    if (!session) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The refresh session has expired or was revoked.",
            { code: "REFRESH_SESSION_EXPIRED", retryable: false },
        );
    }

    // Refresh from current database state rather than trusting stale role/status
    // claims from the old refresh JWT. Suspensions and role changes therefore
    // take effect immediately on the next refresh.
    const user = await prisma.user.findUnique({
        where: { id: refreshUserId },
        select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            role: true,
            status: true,
            staff: { select: { status: true } },
        },
    });

    if (!user) {
        throw new AppError(
            status.UNAUTHORIZED,
            "The authenticated account no longer exists.",
            { code: "REFRESH_SESSION_EXPIRED", retryable: false },
        );
    }

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
        role: user.role,
    };
};

const verifyEmail = async (email: string, otp: string) => {
    // Resolve identity and credential ownership first. ADMIN provisioning is
    // checked before the OTP is consumed so an incomplete tenant cannot become
    // stuck in a verified-but-unusable state.
    const [user, passwordAccount] = await Promise.all([
        prisma.user.findUnique({
            where: { email },
            select: { id: true, role: true },
        }),
        prisma.account.findFirst({
            where: {
                user: { email },
                providerId: "credential",
            },
            select: { userId: true },
        }),
    ]);

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found.");
    }

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Email verification is not allowed for social login accounts.",
        );
    }

    let isOnboardingComplete: boolean | undefined = undefined;

    if (user.role === UserRole.ADMIN) {
        const readiness = await AccountIntegrityService.assertAdminReadyForActivation(user.id);
        isOnboardingComplete = readiness.isOnboardingComplete;
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
            { code: "EMAIL_VERIFICATION_STATE_INVALID", retryable: true },
        );
    }

    result.user = await prisma.user.update({
        where: { email },
        data: { status: AccountStatus.ACTIVE },
    });

    const returnedSessionToken =
        typeof (result as { token?: unknown }).token === "string"
            ? (result as { token: string }).token
            : undefined;
    const sessionToken = await ensureVerifiedSessionToken(
        result.user.id,
        returnedSessionToken,
    );

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };

    return {
        ...result,
        token: sessionToken,
        isOnboardingComplete,
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
    getNewToken,
    verifyEmail,
    resendOtp,
    forgotPassword,
    resetPassword,
    changePassword,
    logout,
};

export default userService;
