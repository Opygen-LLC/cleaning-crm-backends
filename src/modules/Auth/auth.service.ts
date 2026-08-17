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
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import logger from "../../lib/logger";

//? Max sessions per user
const MAX_SESSIONS = 3;

const REGISTRATION_COMPENSATION_ATTEMPTS = 3;
const REGISTRATION_PERSISTENCE_ATTEMPTS = 4;
const REGISTRATION_PERSISTENCE_DELAY_MS = 35;
// An auth-only, unverified ADMIN row can be left behind if an older process
// crashed after Better Auth committed but before tenant provisioning started.
// Never recycle a fresh row: that could belong to a concurrent registration.
const ABANDONED_REGISTRATION_AGE_MS = 60_000;

type RegistrationAuthUser = {
    id: string;
    email: string;
    emailVerified: boolean;
    role: UserRole;
    createdAt: Date;
    admin: { id: string } | null;
    staff: { id: string } | null;
};

const registrationAuthUserSelect = {
    id: true,
    email: true,
    emailVerified: true,
    role: true,
    createdAt: true,
    admin: { select: { id: true } },
    staff: { select: { id: true } },
} as const;

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

const registrationEmailUnavailable = () =>
    new AppError(
        status.CONFLICT,
        "Unable to create an account with this email. If you already have an account, sign in or reset your password.",
        {
            code: "REGISTRATION_EMAIL_UNAVAILABLE",
            retryable: false,
            fieldErrors: {
                email: "This email cannot be used for a new account. Sign in or reset your password if it is yours.",
            },
        },
    );

const findPersistedRegistrationUserById = async (
    userId: string,
): Promise<RegistrationAuthUser | null> => {
    for (let attempt = 1; attempt <= REGISTRATION_PERSISTENCE_ATTEMPTS; attempt += 1) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: registrationAuthUserSelect,
        });

        if (user) return user;

        if (attempt < REGISTRATION_PERSISTENCE_ATTEMPTS) {
            await sleep(REGISTRATION_PERSISTENCE_DELAY_MS * attempt);
        }
    }

    return null;
};

const findRegistrationUserByEmail = async (
    email: string,
): Promise<RegistrationAuthUser | null> =>
    prisma.user.findUnique({
        where: { email },
        select: registrationAuthUserSelect,
    });

const recoverAbandonedRegistrationUser = async (
    user: RegistrationAuthUser,
): Promise<boolean> => {
    if (
        user.role !== UserRole.ADMIN ||
        user.emailVerified ||
        user.admin ||
        user.staff ||
        Date.now() - user.createdAt.getTime() < ABANDONED_REGISTRATION_AGE_MS
    ) {
        return false;
    }

    const cutoff = new Date(Date.now() - ABANDONED_REGISTRATION_AGE_MS);
    const deleted = await prisma.user.deleteMany({
        where: {
            id: user.id,
            email: user.email,
            role: UserRole.ADMIN,
            emailVerified: false,
            createdAt: { lte: cutoff },
            admin: null,
            staff: null,
        },
    });

    if (deleted.count > 0) {
        logger.warn("Recovered abandoned registration auth record before retry", {
            userId: user.id,
            email: user.email,
        });
        return true;
    }

    return false;
};

/**
 * Better Auth 1.5+ intentionally returns a synthetic success user when
 * requireEmailVerification is enabled and the email already exists. That
 * synthetic id must never be used as an AdminProfile foreign key. Prove the
 * returned id exists in our PostgreSQL User table before tenant provisioning.
 *
 * If the synthetic response points at an old auth-only, unverified ADMIN row
 * left by a crashed registration, remove that abandoned row and retry once.
 * Fresh rows are never recycled, which keeps concurrent signups safe.
 */
const createPersistedRegistrationUser = async (input: {
    name: string;
    email: string;
    password: string;
}) => {
    const signUp = async () =>
        auth.api.signUpEmail({
            body: input,
        }).catch((err) => {
            // Older Better Auth versions returned USER_ALREADY_EXISTS. Keep the
            // mapping for rolling deployments even though current versions use
            // a synthetic success response when verification is required.
            if (err?.body?.code === "USER_ALREADY_EXISTS") {
                throw registrationEmailUnavailable();
            }
            throw err;
        });

    for (let signupAttempt = 1; signupAttempt <= 2; signupAttempt += 1) {
        const data = await signUp();

        if (!data.user?.id) {
            throw new AppError(status.BAD_REQUEST, "Failed to register user.", {
                code: "AUTH_USER_CREATION_FAILED",
                retryable: true,
            });
        }

        const persisted = await findPersistedRegistrationUserById(data.user.id);
        if (persisted) {
            if (persisted.email.toLowerCase() !== input.email.toLowerCase()) {
                logger.error("Better Auth returned a persisted user with an unexpected email", {
                    userId: data.user.id,
                });
                throw new AppError(
                    status.INTERNAL_SERVER_ERROR,
                    "Registration identity verification failed. Please try again.",
                    { code: "AUTH_USER_IDENTITY_MISMATCH", retryable: true },
                );
            }
            return data;
        }

        // The returned id is not in PostgreSQL. With verification required this
        // is normally Better Auth's enumeration-protection synthetic response.
        const existing = await findRegistrationUserByEmail(input.email);
        if (!existing) {
            throw new AppError(
                status.SERVICE_UNAVAILABLE,
                "Your authentication account was not committed. Please try again.",
                { code: "AUTH_USER_NOT_PERSISTED", retryable: true },
            );
        }

        if (signupAttempt === 1 && await recoverAbandonedRegistrationUser(existing)) {
            continue;
        }

        throw registrationEmailUnavailable();
    }

    // The loop either returns a persisted user or throws. Keep a fail-closed
    // guard for future refactors/type narrowing.
    throw new AppError(
        status.SERVICE_UNAVAILABLE,
        "Registration could not be completed. Please try again.",
        { code: "REGISTRATION_RETRY_REQUIRED", retryable: true },
    );
};

/**
 * Better Auth creates User/Account rows before tenant provisioning starts.
 * Prisma cannot include that library call in the same transaction, so a failed
 * tenant transaction needs a compensating delete. deleteMany is deliberately
 * idempotent (missing user = success), and a few bounded retries protect signup
 * from leaving an email permanently claimed after a transient DB failure.
 */
const compensateFailedRegistrationUser = async (userId: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= REGISTRATION_COMPENSATION_ATTEMPTS; attempt += 1) {
        try {
            await prisma.user.deleteMany({ where: { id: userId } });
            return true;
        } catch (rollbackError) {
            logger.error("Failed to compensate Better Auth user after provisioning failure", {
                userId,
                attempt,
                attempts: REGISTRATION_COMPENSATION_ATTEMPTS,
                rollbackError,
            });
        }
    }

    return false;
};

const register = async ({
    businessName,
    name,
    email,
    password,
}: IRegisterUserPayload) => {
    const platformConfig = await getPlatformConfig();
    if (!platformConfig.registrationOpen) {
        throw new AppError(
            status.FORBIDDEN,
            "New registrations are currently closed. Please contact support.",
        );
    }

    // Better Auth may return a synthetic user for an existing email when
    // requireEmailVerification=true. Never provision tenant rows from that
    // response until the returned id is proven to exist in PostgreSQL.
    const data = await createPersistedRegistrationUser({
        name,
        email,
        password,
    });

    try {
        const provisioned = await AccountProvisioningService.provisionRegisteredAdmin({
            userId: data.user.id,
            businessName,
            trialDays: platformConfig.defaultTrialDays,
        });

        // Only create/send the verification OTP after all tenant-owned records
        // have committed. Email delivery itself is non-critical: if the mail
        // provider is temporarily unavailable the account remains valid and the
        // existing resend-OTP endpoint can be used from the verification page.
        try {
            await auth.api.sendVerificationOTP({
                body: { email, type: "email-verification" },
            });
        } catch (verificationError) {
            logger.error("Registration succeeded but verification OTP dispatch failed", {
                userId: data.user.id,
                email,
                error: verificationError,
            });
        }

        return {
            user: data.user,
            adminProfile: provisioned.adminProfile,
            subscription: provisioned.subscription,
            website: provisioned.website,
        };
    } catch (error) {
        // Better Auth is outside the tenant transaction. Remove its User row
        // (Account/Session rows cascade) so a failed signup can be retried with
        // the same email and cannot leave an auth-only orphan.
        const compensated = await compensateFailedRegistrationUser(data.user.id);

        logger.error("Registration provisioning failed", {
            userId: data.user.id,
            email,
            compensated,
            error,
        });

        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Registration failed. Please try again.",
            {
                code: "REGISTRATION_PROVISIONING_FAILED",
                retryable: compensated,
            },
        );
    }
};

const login = async ({ email, password }: ILoginUserPayload) => {
    // ✅ Minimal select — also fetch needPasswordChange so the client can
    //    redirect staff to the forced password-change screen on first login.
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            role: true,
            needPasswordChange: true,          // ← added
            staff: { select: { status: true } },
            admin: { select: { onboardingCompletedAt: true } },
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    if (
        user.role === UserRole.STAFF &&
        user.staff?.status === StaffStatus.DEACTIVE
    ) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to login. Please contact with admin.",
        );
    }

    // ✅ signInEmail is unavoidable (bcrypt) — but we can run session cleanup
    //    concurrently AFTER we know the user is valid, not after signIn resolves
    const signIn = await auth.api.signInEmail({
        body: { email, password },
    });

    if (!signIn.user.emailVerified) {
        return { data: signIn, accessToken: null, refreshToken: null };
    }

    // ✅ Let DB do the counting + deleting instead of fetching all rows into JS
    const sessionCount = await prisma.session.count({
        where: { userId: signIn.user.id },
    });

    if (sessionCount > MAX_SESSIONS) {
        // ✅ DB-side: find oldest excess session IDs and delete in one query
        const oldest = await prisma.session.findMany({
            where: { userId: signIn.user.id },
            orderBy: { createdAt: "asc" },
            take: sessionCount - MAX_SESSIONS + 1, // +1 accounts for new session
            select: { id: true }, // only fetch id, not full row
        });

        await prisma.session.deleteMany({
            where: { id: { in: oldest.map((s) => s.id) } },
        });
    }

    const tokenPayload = {
        userId: signIn.user.id,
        role: signIn.user.role,
        name: signIn.user.name,
        email: signIn.user.email,
        emailVerified: signIn.user.emailVerified,
    };

    let isOnboardingComplete: boolean | undefined = undefined;
    if (user.role === UserRole.ADMIN) {
        isOnboardingComplete = user.admin?.onboardingCompletedAt != null;
    }

    return {
        ...signIn,
        // ✅ Expose needPasswordChange so LoginForm can redirect to /set-password
        //    before granting access to any dashboard route.
        needPasswordChange: user.needPasswordChange,
        isOnboardingComplete,
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
    };
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
    if (!sessionToken) {
        throw new AppError(status.UNAUTHORIZED, "Session token is missing");
    }

    const verifiedRefreshToken = jwtUtils.verifyToken(
        refreshToken,
        REFRESH_TOKEN_SECRET,
    );

    if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
        throw new AppError(status.UNAUTHORIZED, "Invalid refresh token");
    }

    const data = verifiedRefreshToken.data as JwtPayload;
    const refreshUserId = data.userId as string | undefined;
    if (!refreshUserId) {
        throw new AppError(status.UNAUTHORIZED, "Invalid refresh token");
    }

    // Bind the Better Auth session and refresh token to the same user. This is
    // both safer and more deterministic than first looking up an arbitrary
    // session and only verifying the refresh token afterwards.
    const session = await prisma.session.findFirst({
        where: {
            token: sessionToken,
            userId: refreshUserId,
        },
        select: {
            id: true,
            token: true,
        },
    });

    if (!session) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token");
    }

    const newAccessToken = tokenUtils.getAccessToken({
        userId: refreshUserId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const newRefreshToken = tokenUtils.getRefreshToken({
        userId: refreshUserId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const { token } = await prisma.session.update({
        where: {
            id: session.id,
        },
        data: {
            expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
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
    // Single query: find user AND verify credential account exists simultaneously
    const [user, passwordAccount] = await Promise.all([
        prisma.user.findUnique({
            where: { email },
            select: { id: true },
        }),
        prisma.account.findFirst({
            where: {
                user: { email }, // join via relation instead of 2 queries
                providerId: "credential",
            },
            select: { userId: true }, // only fetch what's needed
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

    const result = await auth.api.verifyEmailOTP({
        body: { email, otp },
    });

    if (!result?.user) {
        throw new AppError(status.BAD_REQUEST, "Invalid OTP.");
    }

    // Only hit the DB if status update is actually needed
    if (result.user.emailVerified) {
        result.user = await prisma.user.update({
            where: { email },
            data: { status: AccountStatus.ACTIVE },
        });
    }

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };

    let isOnboardingComplete: boolean | undefined = undefined;
    if (result.user.role === UserRole.ADMIN) {
        const admin = await prisma.adminProfile.findUnique({
            where: { userId: result.user.id },
            select: { onboardingCompletedAt: true },
        });
        isOnboardingComplete = admin?.onboardingCompletedAt != null;
    }

    return {
        ...result,
        isOnboardingComplete,
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
    };
};

const resendOtp = async (email: string) => {
    await auth.api.sendVerificationOTP({
        body: { email, type: "email-verification" },
        //? type: "sign-in" | "email-verification" | "forget-password" | "change-email";
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

const logout = async (sessionToken: string) => {
    const result = await auth.api.signOut({
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    return result;
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
